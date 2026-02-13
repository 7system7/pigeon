import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Goa from 'gi://Goa';
import Soup from 'gi://Soup';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { providers } from './providers.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Goa.OAuth2Based.prototype, 'call_get_access_token', 'call_get_access_token_finish');

export class Account {
    constructor({ goaAccount, settings, httpSession, cancellable, logger }) {
        this.goaAccount = goaAccount;
        this._settings = settings;
        this._httpSession = httpSession;
        this._cancellable = cancellable;
        this._logger = logger;

        this.mailbox = goaAccount.get_account().presentation_identity;
        this._provider = providers[goaAccount.get_account().provider_type];
        this._source = null;
        this._errorNotified = false;
    }

    async scanInbox() {
        try {
            const messages = await this._fetchMessages();
            this._errorNotified = false;
            this._processNewMessages(messages);
        } catch (err) {
            if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                this._logger.error(err);
                if (!this._errorNotified) {
                    Main.notifyError(this.mailbox, _('Unable to check emails'));
                    this._errorNotified = true;
                }
            }
        }
    }

    destroy() {
        if (this._source) {
            this._source.destroy();
            this._source = null;
        }
    }

    async _fetchMessages() {
        const token = await this._getAccessToken();
        const priorityOnly = this._settings.get_boolean('priority-only');
        const url = this._provider.getApiURL(priorityOnly);

        const request = Soup.Message.new('GET', url);
        request.request_headers.append('Authorization', `Bearer ${token}`);

        const bytes = await this._httpSession.send_and_read_async(
            request,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
        );

        const status = request.get_status();
        if (status !== 200) {
            throw new Error(`HTTP ${status}: ${request.get_reason_phrase()}`);
        }

        const body = new TextDecoder('utf-8').decode(bytes.get_data());
        return this._provider.parseResponse(body, this.mailbox);
    }

    async _getAccessToken() {
        const oauth2 = this.goaAccount.get_oauth2_based();
        const [accessToken] = await oauth2.call_get_access_token(this._cancellable);
        return accessToken;
    }

    _processNewMessages(messages) {
        const history = this._loadNotificationHistory();
        const currentIds = new Set(messages.map((m) => m.id));
        const previousIds = history[this.mailbox] || [];

        // Keep only IDs that are still in the current inbox
        const seenIds = new Set(previousIds.filter((id) => currentIds.has(id)));

        // Oldest first so newest appear on top in notification stack
        const newMessages = [...messages].reverse().filter((msg) => !seenIds.has(msg.id));

        for (const msg of newMessages) {
            seenIds.add(msg.id);
            this._showNotification(msg);
        }

        history[this.mailbox] = [...seenIds];
        this._settings.set_string('notified-ids', JSON.stringify(history));
    }

    _showNotification(msg) {
        const source = this._getSource();

        const persistent = this._settings.get_boolean('persistent-notifications');
        const notification = new MessageTray.Notification({
            source,
            title: msg.subject,
            body: msg.from,
            iconName: 'mail-unread',
            urgency: persistent ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.NORMAL,
        });

        if (this._settings.get_boolean('play-sound')) {
            notification.sound = new MessageTray.Sound(null, 'message-new-email');
        }

        notification.connect('activated', () => {
            this._openEmail(msg.link);
        });

        source.addNotification(notification);
    }

    _getSource() {
        if (this._source) {
            return this._source;
        }

        this._source = new MessageTray.Source({
            title: this.mailbox,
            iconName: 'mail-message-new',
        });

        this._source.connect('destroy', () => {
            this._source = null;
        });

        Main.messageTray.add(this._source);
        return this._source;
    }

    _openEmail(link) {
        const useMailClient = this._settings.get_boolean('use-mail-client');

        if (useMailClient) {
            const mailto = Gio.app_info_get_default_for_uri_scheme('mailto');
            if (mailto) {
                mailto.launch([], null);
                return;
            }
        }

        Gio.AppInfo.launch_default_for_uri(link || this._provider.getFallbackURL(), null);
    }

    _loadNotificationHistory() {
        try {
            const json = this._settings.get_string('notified-ids');
            return JSON.parse(json || '{}');
        } catch {
            this._settings.set_string('notified-ids', '{}');
            return {};
        }
    }

    clearNotificationHistory() {
        const history = this._loadNotificationHistory();
        if (this.mailbox in history) {
            delete history[this.mailbox];
            this._settings.set_string('notified-ids', JSON.stringify(history));
        }
    }
}
