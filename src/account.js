import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { providers } from './providers.js';

export class Account {
    constructor({ goaAccount, settings, httpSession, cancellable, logger, notifiedIds }) {
        this.goaAccount = goaAccount;
        this._settings = settings;
        this._httpSession = httpSession;
        this._cancellable = cancellable;
        this._logger = logger;
        this._notifiedIds = notifiedIds;

        const account = goaAccount.get_account();
        this.mailbox = account.presentation_identity;
        this._providerType = account.provider_type;
        this._provider = providers[this._providerType];
        this._source = null;
        this._failCount = 0;

        // Determine if this is an OAuth2 or IMAP account
        this._isOAuth2 = !!goaAccount.get_oauth2_based();
        this._mail = goaAccount.get_mail();
    }

    async scanInbox() {
        try {
            const messages = await this._fetchMessages();
            this._failCount = 0;
            this._processNewMessages(messages);
        } catch (err) {
            if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                this._failCount++;
                this._logger.log(`mail check failed (${this._failCount}): ${err.message}`);
                if (this._failCount === 3) {
                    Main.notifyError(this.mailbox, _(`Unable to check emails: ${err.message}`));
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
        if (this._isOAuth2) {
            return await this._fetchMessagesOAuth2();
        } else if (this._providerType === 'imap') {
            return await this._fetchMessagesIMAP();
        } else {
            throw new Error(`Unsupported provider type: ${this._providerType}`);
        }
    }

    async _fetchMessagesOAuth2() {
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

    async _fetchMessagesIMAP() {
        if (!this._mail) {
            throw new Error('IMAP account does not have Mail interface');
        }

        const host = this._mail.email_address.split('@')[1]; // Fallback if ImapHost not set
        const imapHost = this._mail.imap_host || host;
        const imapUserName = this._mail.imap_user_name || this._mail.email_address;

        // Get password from GOA - this requires using the passwordbased interface
        const passwordBased = this.goaAccount.get_password_based();
        if (!passwordBased) {
            throw new Error('IMAP account does not have password');
        }

        const [password] = await new Promise((resolve, reject) => {
            passwordBased.call_get_password(
                'password',
                this._cancellable,
                (source, result) => {
                    try {
                        const [password] = passwordBased.call_get_password_finish(result);
                        resolve([password]);
                    } catch (err) {
                        reject(err);
                    }
                }
            );
        });

        return await this._provider.fetchMessages({
            host: imapHost,
            port: this._mail.imap_use_ssl ? 993 : (this._mail.imap_use_tls ? 143 : 143),
            username: imapUserName,
            password,
            useTls: this._mail.imap_use_ssl || this._mail.imap_use_tls,
            cancellable: this._cancellable,
            logger: this._logger,
        });
    }

    async _getAccessToken() {
        const oauth2 = this.goaAccount.get_oauth2_based();
        const [accessToken] = await oauth2.call_get_access_token(this._cancellable);
        return accessToken;
    }

    _processNewMessages(messages) {
        const currentIds = new Set(messages.map((m) => m.id));
        const ids = this._notifiedIds.get(this.mailbox) || [];

        // Keep only IDs that are still in the current inbox
        const seenIds = new Set(ids.filter((id) => currentIds.has(id)));

        // Oldest first so newest appear on top in notification stack
        const newMessages = [...messages].reverse().filter((msg) => !seenIds.has(msg.id));

        for (const msg of newMessages) {
            seenIds.add(msg.id);
            this._showNotification(msg);
        }

        this._notifiedIds.set(this.mailbox, [...seenIds]);
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
}
