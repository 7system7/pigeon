import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Goa from 'gi://Goa';
import Soup from 'gi://Soup';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Account } from './account.js';
import { providers } from './providers.js';

const SUPPORTED_PROVIDERS = new Set(Object.keys(providers));

Gio._promisify(Goa.Client, 'new', 'new_finish');

export class Manager {
    constructor({ logger, settings }) {
        this._logger = logger;
        this._settings = settings;

        this._cancellable = new Gio.Cancellable();
        this._accounts = [];
        this._httpSession = new Soup.Session();
        this._httpSession.set_timeout(10);

        this._settings.connectObject(
            'changed::check-interval',
            this._restartTimer.bind(this),
            this,
        );

        this._init();
    }

    async _init() {
        try {
            this._goaClient = await Goa.Client.new(this._cancellable);
            this._accounts = this._createAccounts();

            this._goaClient.connectObject(
                'account-added',
                this._onAccountAdded.bind(this),
                'account-removed',
                this._onAccountRemoved.bind(this),
                this,
            );

            if (this._accounts.length === 0) {
                return;
            }

            this._startTimer();
            this._checkAllAccounts();
        } catch (err) {
            if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                this._logger.error(err);
                Main.notifyError('Pigeon', _('Error loading email accounts'));
            }
        }
    }

    destroy() {
        this._cancellable.cancel();

        this._settings.disconnectObject(this);
        this._goaClient?.disconnectObject(this);

        this._stopTimer();

        for (const account of this._accounts) {
            account.destroy();
        }

        this._settings = null;
        this._goaClient = null;
        this._httpSession = null;
        this._cancellable = null;
    }

    get _accountOptions() {
        return {
            settings: this._settings,
            httpSession: this._httpSession,
            cancellable: this._cancellable,
            logger: this._logger,
        };
    }

    _createAccounts() {
        return this._goaClient
            .get_accounts()
            .filter((acc) => SUPPORTED_PROVIDERS.has(acc.get_account().provider_type))
            .map((goaAccount) => new Account({ goaAccount, ...this._accountOptions }));
    }

    _checkAllAccounts() {
        for (const account of this._accounts) {
            account.scanInbox();
        }
    }

    _startTimer() {
        const interval = this._settings.get_int('check-interval');
        this._timerSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._checkAllAccounts();
            return GLib.SOURCE_CONTINUE;
        });
        this._logger.log(`Started pecking (every ${interval}s)`);
    }

    _stopTimer() {
        if (this._timerSourceId) {
            GLib.Source.remove(this._timerSourceId);
            this._timerSourceId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        if (this._accounts.length > 0) {
            this._startTimer();
        }
    }

    _onAccountAdded(_client, goaAccount) {
        const providerType = goaAccount.get_account().provider_type;
        if (!SUPPORTED_PROVIDERS.has(providerType)) {
            return;
        }

        const account = new Account({ goaAccount, ...this._accountOptions });
        this._accounts.push(account);

        if (this._accounts.length === 1) {
            this._startTimer();
        }

        account.scanInbox();
    }

    _onAccountRemoved(_client, goaAccount) {
        const mailbox = goaAccount.get_account().presentation_identity;
        const account = this._accounts.find((acc) => acc.mailbox === mailbox);

        if (!account) {
            return;
        }

        account.clearNotificationHistory();
        account.destroy();

        this._accounts = this._accounts.filter((acc) => acc !== account);
        if (this._accounts.length === 0) {
            this._stopTimer();
        }
    }
}
