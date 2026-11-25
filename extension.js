import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClipboardWatcher} from './clipboardWatcher.js';
import {HistoryStore} from './historyStore.js';
import {SmartClipboardIndicator} from './popupUi.js';

const SHORTCUT_KEY = 'toggle-shortcut';

export default class SmartClipboardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsChangedId = 0;

        this._store = new HistoryStore({
            uuid: this.uuid,
            config: this._readStoreConfig(),
            onChanged: () => {
                this._indicator?.refresh();
            },
        });

        this._watcher = new ClipboardWatcher({
            paused: this._settings.get_boolean('private-mode'),
            captureImages: this._settings.get_boolean('capture-images'),
            maxImageSizeMb: this._settings.get_int('max-image-size-mb'),
            onText: text => this._store.addText(text),
            onImage: (bytes, mimeType) => this._store.addImage(bytes, mimeType),
        });

        this._indicator = new SmartClipboardIndicator({
            store: this._store,
            isPaused: this._settings.get_boolean('private-mode'),
            onSelectEntry: entry => {
                this._watcher?.copyEntryToClipboard(entry, this._store).catch(e => {
                    console.warn(`[smart-clipboard] Copy back failed: ${e.message}`);
                });
            },
            onTogglePause: paused => {
                this._settings?.set_boolean('private-mode', paused);
            },
            onOpenPreferences: () => {
                this.openPreferences();
            },
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        Main.wm.addKeybinding(
            SHORTCUT_KEY,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                this._indicator?.toggleMenu();
            }
        );

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            this._onSettingChanged(key);
        });

        this._store.load().catch(e => {
            console.warn(`[smart-clipboard] Initial store load failed: ${e.message}`);
        });
    }

    _readStoreConfig() {
        return {
            maxTextHistory: this._settings.get_int('max-text-history'),
            maxImageHistory: this._settings.get_int('max-image-history'),
            maxImageSizeMb: this._settings.get_int('max-image-size-mb'),
            persistHistory: this._settings.get_boolean('persist-history'),
        };
    }

    _onSettingChanged(key) {
        if (!this._settings || !this._store || !this._watcher)
            return;

        switch (key) {
        case 'max-text-history':
        case 'max-image-history':
        case 'max-image-size-mb':
        case 'persist-history':
            this._store.setConfig(this._readStoreConfig());
            this._watcher.setConfig({
                maxImageSizeMb: this._settings.get_int('max-image-size-mb'),
            });
            break;

        case 'capture-images':
            this._watcher.setConfig({
                captureImages: this._settings.get_boolean('capture-images'),
            });
            break;

        case 'private-mode': {
            const paused = this._settings.get_boolean('private-mode');
            this._watcher.setConfig({paused});
            this._indicator?.setPaused(paused);
            break;
        }

        case 'wipe-nonce':
            this._store.wipeAll().catch(e => {
                console.warn(`[smart-clipboard] Wipe failed: ${e.message}`);
            });
            break;

        default:
            break;
        }
    }

    disable() {
        Main.wm.removeKeybinding(SHORTCUT_KEY);

        if (this._settings && this._settingsChangedId !== 0) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._watcher) {
            this._watcher.destroy();
            this._watcher = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._store) {
            this._store.destroy();
            this._store = null;
        }

        this._settings = null;
    }
}
