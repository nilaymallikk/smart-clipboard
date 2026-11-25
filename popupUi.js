import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export const SmartClipboardIndicator = GObject.registerClass(
class SmartClipboardIndicator extends PanelMenu.Button {
    _init({
        onTogglePopup,
        onTogglePause,
        onToggleAutoPaste,
        onClearUnpinned,
        onOpenPreferences,
        isPaused = false,
        autoPaste = true,
    }) {
        super._init(0.5, 'Smart Clipboard', false);

        this._onTogglePopup = onTogglePopup;
        this._onTogglePause = onTogglePause;
        this._onToggleAutoPaste = onToggleAutoPaste;
        this._onClearUnpinned = onClearUnpinned;
        this._onOpenPreferences = onOpenPreferences;
        this._paused = isPaused;
        this._autoPaste = autoPaste;
        this._syncingSwitches = false;

        this._panelIcon = new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._panelIcon);

        this._buildQuickMenu();
        this.setPaused(isPaused);
        this.setAutoPaste(autoPaste);
    }

    _buildQuickMenu() {
        const openItem = new PopupMenu.PopupMenuItem('Open Smart Clipboard');
        openItem.connect('activate', () => {
            this._onTogglePopup?.();
        });
        this.menu.addMenuItem(openItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._privateSwitch = new PopupMenu.PopupSwitchMenuItem('Private Mode (Pause)', this._paused);
        this._privateSwitch.connect('toggled', (_item, state) => {
            if (!this._syncingSwitches)
                this._onTogglePause?.(state);
        });
        this.menu.addMenuItem(this._privateSwitch);

        this._autoPasteSwitch = new PopupMenu.PopupSwitchMenuItem('Auto-Paste on Enter', this._autoPaste);
        this._autoPasteSwitch.connect('toggled', (_item, state) => {
            if (!this._syncingSwitches)
                this._onToggleAutoPaste?.(state);
        });
        this.menu.addMenuItem(this._autoPasteSwitch);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._clearItem = new PopupMenu.PopupMenuItem('Clear Unpinned History');
        this._clearItem.connect('activate', () => {
            this._onClearUnpinned?.();
        });
        this.menu.addMenuItem(this._clearItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences…');
        prefsItem.connect('activate', () => {
            this._onOpenPreferences?.();
        });
        this.menu.addMenuItem(prefsItem);
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS) {
            const button = event.get_button();
            if (button === Clutter.BUTTON_PRIMARY) {
                if (this.menu.isOpen)
                    this.menu.close();
                this._onTogglePopup?.();
                return Clutter.EVENT_STOP;
            }
            if (button === Clutter.BUTTON_SECONDARY) {
                this.menu.toggle();
                return Clutter.EVENT_STOP;
            }
        }
        return super.vfunc_event(event);
    }

    setPaused(paused) {
        this._paused = Boolean(paused);
        if (this._paused)
            this._panelIcon.add_style_class_name('smart-clipboard-panel-paused');
        else
            this._panelIcon.remove_style_class_name('smart-clipboard-panel-paused');

        if (this._privateSwitch) {
            this._syncingSwitches = true;
            this._privateSwitch.setToggleState(this._paused);
            this._syncingSwitches = false;
        }
    }

    setAutoPaste(enabled) {
        this._autoPaste = Boolean(enabled);
        if (this._autoPasteSwitch) {
            this._syncingSwitches = true;
            this._autoPasteSwitch.setToggleState(this._autoPaste);
            this._syncingSwitches = false;
        }
    }

    setHasUnpinned(hasUnpinned) {
        if (this._clearItem)
            this._clearItem.setSensitive(Boolean(hasUnpinned));
    }

    destroy() {
        this._onTogglePopup = null;
        this._onTogglePause = null;
        this._onToggleAutoPaste = null;
        this._onClearUnpinned = null;
        this._onOpenPreferences = null;
        super.destroy();
    }
});
