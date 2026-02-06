import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class PigeonPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const notificationGroup = new Adw.PreferencesGroup({
            title: _('Notifications'),
            description: _('Configure notification behavior'),
        });
        page.add(notificationGroup);

        const priorityOnlyRow = new Adw.SwitchRow({
            title: _('Priority only'),
            subtitle: _('Only notify for important emails'),
        });
        settings.bind('priority-only', priorityOnlyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        notificationGroup.add(priorityOnlyRow);

        const intervalRow = new Adw.SpinRow({
            title: _('Check interval'),
            subtitle: _('Time in seconds between email checks'),
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 1800,
                step_increment: 10,
                page_increment: 60,
            }),
        });
        settings.bind('check-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        notificationGroup.add(intervalRow);

        const playSoundRow = new Adw.SwitchRow({
            title: _('Play sound'),
            subtitle: _('Play a notification sound when new emails arrive'),
        });
        settings.bind('play-sound', playSoundRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        notificationGroup.add(playSoundRow);

        const persistentRow = new Adw.SwitchRow({
            title: _('Persistent notifications'),
            subtitle: _('Keep notifications visible until dismissed'),
        });
        settings.bind(
            'persistent-notifications',
            persistentRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT,
        );
        notificationGroup.add(persistentRow);

        const emailClientGroup = new Adw.PreferencesGroup({
            title: _('Email Client'),
            description: _('Configure how to open emails'),
        });
        page.add(emailClientGroup);

        const useMailRow = new Adw.SwitchRow({
            title: _('Use default email client'),
            subtitle: _('Launch mail client when clicking notifications'),
        });
        settings.bind('use-mail-client', useMailRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        emailClientGroup.add(useMailRow);
    }
}
