import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Manager } from './manager.js';

export default class Pigeon extends Extension {
    enable() {
        this._manager = new Manager({
            logger: this.getLogger(),
            settings: this.getSettings(),
        });
    }

    disable() {
        this._manager.destroy();
        this._manager = null;
    }
}
