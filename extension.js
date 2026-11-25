import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClipboardWatcher} from './clipboardWatcher.js';
import {
    ClipboardDBusService,
    POPUP_APP_ID,
    POPUP_IFACE_NAME,
    POPUP_OBJECT_PATH,
} from './dbusService.js';
import {HistoryStore} from './historyStore.js';
import {SmartClipboardIndicator} from './popupUi.js';

const SHORTCUT_KEY = 'smart-clipboard-toggle';
const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
const MESSAGE_TRAY_KEY = 'toggle-message-tray';
const AUTO_PASTE_DELAY_MS = 110;
const TERMINAL_CLASS_RE = /(terminal|ptyxis|kgx|console|alacritty|kitty|wezterm|foot|ghostty|tilix|konsole|terminator|xterm|urxvt|st-256color|rio|warp|hyper)/i;

export default class SmartClipboardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsChangedId = 0;
        this._windowCreatedId = 0;
        this._windowMapId = 0;
        this._pasteTimeoutId = 0;
        this._prewarmTimeoutId = 0;
        this._retryShowTimeoutId = 0;
        this._popupProc = null;
        this._popupWin = null;
        this._popupSizeId = 0;
        this._lastFocusWindow = null;
        this._virtualKeyboard = null;
        this._shellKeybindings = null;
        this._savedMessageTrayShortcut = null;

        this._store = new HistoryStore({
            uuid: this.uuid,
            config: this._readStoreConfig(),
            onChanged: () => {
                this._indicator?.setHasUnpinned(this._store.entries.some(e => !e.pinned));
                this._dbusService?.emitChanged();
            },
        });

        this._watcher = new ClipboardWatcher({
            paused: this._settings.get_boolean('private-mode'),
            captureImages: this._settings.get_boolean('capture-images'),
            maxImageSizeMb: this._settings.get_int('max-image-size-mb'),
            onText: text => this._store.addText(text, {sourceApp: this._getFocusedAppName()}),
            onImage: (bytes, mimeType) =>
                this._store.addImage(bytes, mimeType, {sourceApp: this._getFocusedAppName()}),
        });

        this._dbusService = new ClipboardDBusService({
            getState: () => ({
                entries: this._store.getSerializableEntries(),
                paused: this._settings.get_boolean('private-mode'),
                autoPaste: this._settings.get_boolean('auto-paste'),
                shortcut: this._settings.get_strv(SHORTCUT_KEY)[0] ?? '<Super>v',
            }),
            copyEntry: async (id, paste) => {
                const entry = this._store.getEntry(id);
                if (!entry)
                    return false;
                const ok = await this._watcher.copyEntryToClipboard(entry, this._store);
                if (ok && paste && this._settings.get_boolean('auto-paste'))
                    this._scheduleAutoPaste();
                return ok;
            },
            togglePin: id => this._store.togglePin(id),
            reorderPinned: (sourceId, targetId) => this._store.reorderPinned(sourceId, targetId),
            deleteEntry: id => this._store.deleteItem(id),
            clearUnpinned: () => this._store.clearUnpinned(),
            undoDelete: () => this._store.undoLastDelete(),
            setPaused: paused => this._settings.set_boolean('private-mode', paused),
            openPreferences: () => this.openPreferences(),
        });

        this._indicator = new SmartClipboardIndicator({
            isPaused: this._settings.get_boolean('private-mode'),
            autoPaste: this._settings.get_boolean('auto-paste'),
            onTogglePopup: () => this._togglePopup(),
            onTogglePause: paused => this._settings?.set_boolean('private-mode', paused),
            onToggleAutoPaste: enabled => this._settings?.set_boolean('auto-paste', enabled),
            onClearUnpinned: () => this._store?.clearUnpinned(),
            onOpenPreferences: () => this.openPreferences(),
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._claimToggleShortcut();

        Main.wm.addKeybinding(
            SHORTCUT_KEY,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._togglePopup()
        );

        this._windowCreatedId = global.display.connect('window-created', (_display, win) => {
            if (!win || win.get_gtk_application_id?.() !== POPUP_APP_ID)
                return;
            this._preparePopupWindow(win);
        });

        this._windowMapId = global.window_manager.connect('map', (_wm, actor) => {
            const win = actor?.meta_window;
            if (!win || win.get_gtk_application_id?.() !== POPUP_APP_ID)
                return;
            this._positionPopupWindow(win);
            this._animatePopupIn(actor);
        });

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            this._onSettingChanged(key);
        });

        this._store.load()
            .catch(e => {
                console.warn(`[smart-clipboard] Initial store load failed: ${e.message}`);
            })
            .finally(() => {
                this._schedulePrewarm();
            });
    }

    _claimToggleShortcut() {
        // GNOME Shell binds <Super>v to toggle-message-tray by default alongside <Super>m.
        // Release any conflicting binding from toggle-message-tray while active so Super+V opens Smart Clipboard.
        try {
            const wanted = this._settings.get_strv(SHORTCUT_KEY).map(s => s.toLowerCase());
            if (wanted.length === 0)
                return;
            this._shellKeybindings = new Gio.Settings({schema_id: SHELL_KEYBINDINGS_SCHEMA});
            const current = this._shellKeybindings.get_strv(MESSAGE_TRAY_KEY);
            const filtered = current.filter(accel => !wanted.includes(accel.toLowerCase()));
            if (filtered.length !== current.length) {
                this._savedMessageTrayShortcut = current;
                this._shellKeybindings.set_strv(MESSAGE_TRAY_KEY, filtered);
            }
        } catch (e) {
            console.warn(`[smart-clipboard] Shortcut conflict check skipped: ${e.message}`);
        }
    }

    _restoreToggleShortcut() {
        if (this._shellKeybindings && this._savedMessageTrayShortcut) {
            try {
                this._shellKeybindings.set_strv(MESSAGE_TRAY_KEY, this._savedMessageTrayShortcut);
            } catch {
                // ignore
            }
        }
        this._savedMessageTrayShortcut = null;
        this._shellKeybindings = null;
    }

    _getFocusedAppName() {
        const win = global.display.focus_window;
        if (!win)
            return null;
        if (win.get_gtk_application_id?.() === POPUP_APP_ID)
            return null;
        try {
            const app = Shell.WindowTracker.get_default().get_window_app(win);
            if (app)
                return app.get_name();
        } catch {
            // fallback to wm_class
        }
        return win.get_wm_class?.() ?? null;
    }

    _findPopupWindow() {
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win && win.get_gtk_application_id?.() === POPUP_APP_ID)
                return win;
        }
        return null;
    }

    _positionPopupWindow(win) {
        try {
            const monitorIdx = global.display.get_current_monitor();
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIdx);
            const rect = win.get_frame_rect();
            if (workArea && rect.width > 0 && rect.height > 0) {
                const x = Math.max(
                    workArea.x + 8,
                    Math.round(workArea.x + workArea.width - rect.width - 16)
                );
                const y = Math.round(workArea.y + 8);
                win.move_frame(false, x, y);
            }
        } catch {
            // ignore positioning error
        }
    }

    _preparePopupWindow(win) {
        try {
            if (this._popupWin !== win) {
                if (this._popupWin && this._popupSizeId !== 0) {
                    try {
                        this._popupWin.disconnect(this._popupSizeId);
                    } catch {
                        // ignore
                    }
                    this._popupSizeId = 0;
                }
                this._popupWin = win;
                this._popupSizeId = win.connect('size-changed', () => {
                    this._positionPopupWindow(win);
                });
            }
            win.make_above();
            this._positionPopupWindow(win);
            win.activate(global.get_current_time());
        } catch (e) {
            console.warn(`[smart-clipboard] Failed to position/activate popup: ${e.message}`);
        }
    }

    _animatePopupIn(actor) {
        try {
            actor.remove_all_transitions();
            actor.opacity = 0;
            actor.translation_y = -8;
            actor.ease({
                opacity: 255,
                translation_y: 0,
                duration: 115,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } catch {
            actor.opacity = 255;
            actor.translation_y = 0;
        }
    }

    _schedulePrewarm() {
        if (this._prewarmTimeoutId !== 0)
            return;
        this._prewarmTimeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, 350, () => {
            this._prewarmTimeoutId = 0;
            if (!this._popupProc)
                this._spawnPopupProcess({hidden: true});
            return GLib.SOURCE_REMOVE;
        });
    }

    _togglePopup() {
        const focused = global.display.focus_window;
        if (focused && focused.get_gtk_application_id?.() !== POPUP_APP_ID)
            this._lastFocusWindow = focused;

        Gio.DBus.session.call(
            POPUP_APP_ID,
            POPUP_OBJECT_PATH,
            POPUP_IFACE_NAME,
            'Toggle',
            null,
            null,
            Gio.DBusCallFlags.NO_AUTO_START,
            600,
            null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                    const win = this._findPopupWindow();
                    if (win && !win.minimized)
                        this._preparePopupWindow(win);
                } catch {
                    if (this._popupProc) {
                        this._scheduleRetryShow();
                    } else {
                        this._spawnPopupProcess({hidden: false});
                    }
                }
            }
        );
    }

    _scheduleRetryShow() {
        if (this._retryShowTimeoutId !== 0) {
            GLib.Source.remove(this._retryShowTimeoutId);
            this._retryShowTimeoutId = 0;
        }
        this._retryShowTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => {
            this._retryShowTimeoutId = 0;
            Gio.DBus.session.call(
                POPUP_APP_ID,
                POPUP_OBJECT_PATH,
                POPUP_IFACE_NAME,
                'Show',
                null,
                null,
                Gio.DBusCallFlags.NO_AUTO_START,
                600,
                null,
                null
            );
            return GLib.SOURCE_REMOVE;
        });
    }

    _spawnPopupProcess({hidden = false} = {}) {
        if (this._popupProc)
            return;

        const scriptPath = GLib.build_filenamev([this.path, 'popupApp.js']);
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
            if (hidden)
                launcher.setenv('SMART_CLIPBOARD_START_HIDDEN', '1', true);
            const proc = launcher.spawnv(['gjs', '-m', scriptPath]);
            this._popupProc = proc;
            proc.wait_async(null, (p, res) => {
                try {
                    p.wait_finish(res);
                } catch {
                    // ignore
                }
                if (this._popupProc === p)
                    this._popupProc = null;
            });
        } catch (e) {
            console.warn(`[smart-clipboard] Failed to launch popup window: ${e.message}`);
        }
    }

    _quitPopupProcess() {
        Gio.DBus.session.call(
            POPUP_APP_ID,
            POPUP_OBJECT_PATH,
            POPUP_IFACE_NAME,
            'Quit',
            null,
            null,
            Gio.DBusCallFlags.NO_AUTO_START,
            500,
            null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch {
                    // popup wasn't running
                }
            }
        );

        if (this._popupProc) {
            try {
                this._popupProc.force_exit();
            } catch {
                // ignore
            }
            this._popupProc = null;
        }
    }

    _isTerminalWindow(win) {
        if (!win)
            return false;
        const wmClass = win.get_wm_class?.() ?? '';
        const wmInstance = win.get_wm_class_instance?.() ?? '';
        const appId = win.get_gtk_application_id?.() ?? '';
        return TERMINAL_CLASS_RE.test(`${wmClass} ${wmInstance} ${appId}`);
    }

    _scheduleAutoPaste() {
        if (this._pasteTimeoutId !== 0) {
            GLib.Source.remove(this._pasteTimeoutId);
            this._pasteTimeoutId = 0;
        }

        const targetWin = this._lastFocusWindow;
        if (targetWin) {
            try {
                const stillAlive = global.get_window_actors().some(a => a.meta_window === targetWin);
                if (stillAlive)
                    targetWin.activate(global.get_current_time());
            } catch {
                // ignore
            }
        }

        this._pasteTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AUTO_PASTE_DELAY_MS, () => {
            this._pasteTimeoutId = 0;
            this._sendPasteKeystroke(this._isTerminalWindow(global.display.focus_window ?? targetWin));
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPasteKeystroke(useShift) {
        try {
            if (!this._virtualKeyboard) {
                const backend = global.stage.context?.get_backend?.()
                    ?? global.stage.get_context?.()?.get_backend?.();
                const seat = backend?.get_default_seat?.();
                if (!seat)
                    return;
                this._virtualKeyboard = seat.create_virtual_device(
                    Clutter.InputDeviceType.KEYBOARD_DEVICE
                );
            }
            const t = GLib.get_monotonic_time();
            this._virtualKeyboard.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            if (useShift)
                this._virtualKeyboard.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
            this._virtualKeyboard.notify_keyval(t, Clutter.KEY_v, Clutter.KeyState.PRESSED);
            this._virtualKeyboard.notify_keyval(t, Clutter.KEY_v, Clutter.KeyState.RELEASED);
            if (useShift)
                this._virtualKeyboard.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
            this._virtualKeyboard.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        } catch (e) {
            console.warn(`[smart-clipboard] Virtual keyboard auto-paste unavailable: ${e.message}`);
        }
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
            this._dbusService?.emitChanged();
            break;
        }

        case 'auto-paste': {
            const autoPaste = this._settings.get_boolean('auto-paste');
            this._indicator?.setAutoPaste(autoPaste);
            this._dbusService?.emitChanged();
            break;
        }

        case SHORTCUT_KEY:
            this._restoreToggleShortcut();
            this._claimToggleShortcut();
            this._dbusService?.emitChanged();
            break;

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
        this._restoreToggleShortcut();

        if (this._pasteTimeoutId !== 0) {
            GLib.Source.remove(this._pasteTimeoutId);
            this._pasteTimeoutId = 0;
        }
        if (this._prewarmTimeoutId !== 0) {
            GLib.Source.remove(this._prewarmTimeoutId);
            this._prewarmTimeoutId = 0;
        }
        if (this._retryShowTimeoutId !== 0) {
            GLib.Source.remove(this._retryShowTimeoutId);
            this._retryShowTimeoutId = 0;
        }
        if (this._windowCreatedId !== 0) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        if (this._windowMapId !== 0) {
            global.window_manager.disconnect(this._windowMapId);
            this._windowMapId = 0;
        }
        if (this._settings && this._settingsChangedId !== 0) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._popupWin && this._popupSizeId !== 0) {
            try {
                this._popupWin.disconnect(this._popupSizeId);
            } catch {
                // ignore
            }
            this._popupSizeId = 0;
        }
        this._popupWin = null;

        this._quitPopupProcess();

        if (this._dbusService) {
            this._dbusService.destroy();
            this._dbusService = null;
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

        this._virtualKeyboard = null;
        this._lastFocusWindow = null;
        this._settings = null;
    }
}
