import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {formatBytes} from './historyStore.js';

const MAX_PREVIEW_LINES = 3;
const MAX_LINE_CHARS = 78;
const THUMB_DISPLAY_WIDTH = 220;
const THUMB_DISPLAY_HEIGHT = 88;

function formatTextPreview(text) {
    const rawLines = text.replace(/\r\n/g, '\n').split('\n');
    const previewLines = [];
    for (const raw of rawLines) {
        const line = raw.trimEnd().replace(/\t/g, '  ');
        if (previewLines.length === 0 && line.trim().length === 0)
            continue;
        previewLines.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
        if (previewLines.length >= MAX_PREVIEW_LINES)
            break;
    }
    let preview = previewLines.join('\n');
    if (rawLines.length > MAX_PREVIEW_LINES && !preview.endsWith('…'))
        preview += '…';
    return preview || text.slice(0, MAX_LINE_CHARS);
}

function formatTextMeta(entry) {
    const parts = [];
    if (entry.isUrl)
        parts.push('URL');
    parts.push(`${entry.charCount} ${entry.charCount === 1 ? 'char' : 'chars'}`);
    if (entry.lineCount > 1)
        parts.push(`${entry.lineCount} lines`);
    return parts.join(' · ');
}

function formatImageMeta(entry) {
    const fmt = (entry.mimeType?.split('/')[1] ?? 'image').toUpperCase().replace('JPEG', 'JPG');
    const parts = [fmt];
    if (entry.width > 0 && entry.height > 0)
        parts.push(`${entry.width}×${entry.height}`);
    if (entry.sizeBytes > 0)
        parts.push(formatBytes(entry.sizeBytes));
    return parts.join(' · ');
}

export const SmartClipboardIndicator = GObject.registerClass(
class SmartClipboardIndicator extends PanelMenu.Button {
    _init({store, onSelectEntry, onTogglePause, onOpenPreferences, isPaused = false}) {
        super._init(0.5, 'Smart Clipboard', false);

        this._store = store;
        this._onSelectEntry = onSelectEntry;
        this._onTogglePause = onTogglePause;
        this._onOpenPreferences = onOpenPreferences;
        this._paused = isPaused;
        this._filteredEntries = [];
        this._rows = [];
        this._selectedIndex = -1;
        this._focusIdleId = 0;
        this._destroyed = false;

        // Top-bar panel icon
        this._panelIcon = new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon smart-clipboard-panel-icon',
        });
        this.add_child(this._panelIcon);

        this._buildMenu();
        this.setPaused(this._paused);

        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._onMenuOpened();
            else
                this._cancelFocusIdle();
        });

        this._capturedEventId = this.menu.actor.connect('captured-event', (_actor, event) => {
            return this._onCapturedEvent(event);
        });
    }

    _buildMenu() {
        this._rootBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'smart-clipboard-menu',
            x_expand: true,
        });

        // Search row
        const searchRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'smart-clipboard-search-row',
            x_expand: true,
        });

        this._searchEntry = new St.Entry({
            style_class: 'smart-clipboard-search-entry',
            hint_text: 'Search clipboard history…',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({
                icon_name: 'edit-find-symbolic',
                style_class: 'smart-clipboard-search-icon',
            }),
        });

        this._clearSearchIcon = new St.Icon({
            icon_name: 'edit-clear-symbolic',
            style_class: 'smart-clipboard-search-clear-icon',
        });
        this._searchEntry.set_secondary_icon(null);
        this._searchSecondaryClickId = this._searchEntry.connect('secondary-icon-clicked', () => {
            this._searchEntry.set_text('');
            this._searchEntry.grab_key_focus();
        });

        this._searchTextChangedId = this._searchEntry.clutter_text.connect('text-changed', () => {
            const hasText = this._searchEntry.get_text().length > 0;
            this._searchEntry.set_secondary_icon(hasText ? this._clearSearchIcon : null);
            this._selectedIndex = 0;
            this.refresh();
        });

        searchRow.add_child(this._searchEntry);
        this._rootBox.add_child(searchRow);

        // Paused banner (shown only in Private Mode)
        this._pausedBanner = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'smart-clipboard-paused-banner',
            x_expand: true,
            visible: false,
        });
        this._pausedBanner.add_child(new St.Icon({
            icon_name: 'action-unavailable-symbolic',
            style_class: 'smart-clipboard-paused-banner-icon',
        }));
        this._pausedBanner.add_child(new St.Label({
            text: 'Private Mode active — new copies are not recorded',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
        this._rootBox.add_child(this._pausedBanner);

        // Scrollable items list
        this._scrollView = new St.ScrollView({
            style_class: 'smart-clipboard-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });

        this._listBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'smart-clipboard-list',
            x_expand: true,
        });
        this._scrollView.set_child(this._listBox);
        this._rootBox.add_child(this._scrollView);

        // Footer toolbar
        const footer = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'smart-clipboard-footer',
            x_expand: true,
        });

        this._pauseBtn = new St.Button({
            style_class: 'smart-clipboard-footer-btn',
            reactive: true,
            can_focus: true,
        });
        const pauseBtnBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'smart-clipboard-btn-inner',
        });
        this._pauseBtnIcon = new St.Icon({
            icon_name: 'media-playback-pause-symbolic',
            style_class: 'smart-clipboard-footer-icon',
        });
        this._pauseBtnLabel = new St.Label({
            text: 'Private Mode',
            y_align: Clutter.ActorAlign.CENTER,
        });
        pauseBtnBox.add_child(this._pauseBtnIcon);
        pauseBtnBox.add_child(this._pauseBtnLabel);
        this._pauseBtn.set_child(pauseBtnBox);
        this._pauseBtn.connect('clicked', () => {
            this._onTogglePause?.(!this._paused);
            this._focusSearch();
        });

        this._clearBtn = new St.Button({
            style_class: 'smart-clipboard-footer-btn',
            reactive: true,
            can_focus: true,
        });
        const clearBtnBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'smart-clipboard-btn-inner',
        });
        clearBtnBox.add_child(new St.Icon({
            icon_name: 'edit-clear-all-symbolic',
            style_class: 'smart-clipboard-footer-icon',
        }));
        clearBtnBox.add_child(new St.Label({
            text: 'Clear Unpinned',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._clearBtn.set_child(clearBtnBox);
        this._clearBtn.connect('clicked', () => {
            this._store.clearUnpinned();
            this._focusSearch();
        });

        const spacer = new St.Widget({x_expand: true});

        this._prefsBtn = new St.Button({
            style_class: 'smart-clipboard-footer-btn smart-clipboard-icon-btn',
            reactive: true,
            can_focus: true,
            accessible_name: 'Smart Clipboard Preferences',
            child: new St.Icon({
                icon_name: 'preferences-system-symbolic',
                style_class: 'smart-clipboard-footer-icon',
            }),
        });
        this._prefsBtn.connect('clicked', () => {
            this.menu.close();
            this._onOpenPreferences?.();
        });

        footer.add_child(this._pauseBtn);
        footer.add_child(this._clearBtn);
        footer.add_child(spacer);
        footer.add_child(this._prefsBtn);

        this._rootBox.add_child(footer);
        this.menu.box.add_child(this._rootBox);
    }

    toggleMenu() {
        if (this._destroyed)
            return;
        this.menu.toggle();
    }

    setPaused(paused) {
        this._paused = Boolean(paused);
        if (this._destroyed)
            return;

        this._pausedBanner.visible = this._paused;
        if (this._paused) {
            this._panelIcon.add_style_class_name('smart-clipboard-panel-paused');
            this._pauseBtn.add_style_class_name('smart-clipboard-footer-btn-active');
            this._pauseBtnIcon.icon_name = 'media-playback-start-symbolic';
            this._pauseBtnLabel.text = 'Resume';
        } else {
            this._panelIcon.remove_style_class_name('smart-clipboard-panel-paused');
            this._pauseBtn.remove_style_class_name('smart-clipboard-footer-btn-active');
            this._pauseBtnIcon.icon_name = 'media-playback-pause-symbolic';
            this._pauseBtnLabel.text = 'Private Mode';
        }
    }

    refresh() {
        if (this._destroyed)
            return;

        const query = this._searchEntry.get_text();
        this._filteredEntries = this._store.filter(query);
        this._rows = [];
        this._listBox.destroy_all_children();

        if (this._filteredEntries.length === 0) {
            this._selectedIndex = -1;
            const emptyLabel = new St.Label({
                text: query.trim() ? 'No matching clipboard entries' : 'Clipboard history is empty',
                style_class: 'smart-clipboard-empty',
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            this._listBox.add_child(emptyLabel);
            this._updateClearButtonState();
            return;
        }

        if (this._selectedIndex < 0)
            this._selectedIndex = 0;
        else if (this._selectedIndex >= this._filteredEntries.length)
            this._selectedIndex = this._filteredEntries.length - 1;

        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let sawPinned = false;
        let addedSeparator = false;

        for (let i = 0; i < this._filteredEntries.length; i++) {
            const entry = this._filteredEntries[i];
            if (entry.pinned) {
                sawPinned = true;
            } else if (sawPinned && !addedSeparator) {
                addedSeparator = true;
                this._listBox.add_child(new St.Widget({
                    style_class: 'smart-clipboard-divider',
                    x_expand: true,
                }));
            }

            const row = this._createRow(entry, i, scaleFactor);
            this._rows.push(row);
            this._listBox.add_child(row);
        }

        this._updateSelectionHighlight();
        this._updateClearButtonState();
    }

    _updateClearButtonState() {
        const hasUnpinned = this._store.entries.some(e => !e.pinned);
        this._clearBtn.reactive = hasUnpinned;
        this._clearBtn.opacity = hasUnpinned ? 255 : 110;
    }

    _createRow(entry, index, scaleFactor) {
        const row = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: entry.pinned
                ? 'smart-clipboard-row smart-clipboard-row-pinned'
                : 'smart-clipboard-row',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });

        const contentBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'smart-clipboard-row-content',
            x_expand: true,
        });

        if (entry.type === 'text') {
            const previewLabel = new St.Label({
                text: formatTextPreview(entry.text),
                style_class: 'smart-clipboard-text-preview',
                x_expand: true,
            });
            previewLabel.clutter_text.line_wrap = true;
            previewLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            previewLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            contentBox.add_child(previewLabel);

            contentBox.add_child(new St.Label({
                text: formatTextMeta(entry),
                style_class: 'smart-clipboard-meta',
                x_expand: true,
            }));
        } else if (entry.type === 'image') {
            const thumbFrame = new St.Bin({
                style_class: 'smart-clipboard-thumb-frame',
                x_align: Clutter.ActorAlign.START,
            });
            const thumbFile = this._store.getThumbFile(entry);
            if (thumbFile) {
                const actor = St.TextureCache.get_default().load_file_async(
                    thumbFile,
                    THUMB_DISPLAY_WIDTH,
                    THUMB_DISPLAY_HEIGHT,
                    scaleFactor,
                    1.0
                );
                if (actor)
                    thumbFrame.set_child(actor);
            }
            contentBox.add_child(thumbFrame);

            contentBox.add_child(new St.Label({
                text: formatImageMeta(entry),
                style_class: 'smart-clipboard-meta',
                x_expand: true,
            }));
        }

        const actionsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'smart-clipboard-row-actions',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const pinBtn = new St.Button({
            style_class: entry.pinned
                ? 'smart-clipboard-action-btn smart-clipboard-pin-active'
                : 'smart-clipboard-action-btn',
            reactive: true,
            accessible_name: entry.pinned ? 'Unpin item' : 'Pin item',
            child: new St.Icon({
                icon_name: 'view-pin-symbolic',
                style_class: 'smart-clipboard-action-icon',
            }),
        });
        pinBtn.connect('clicked', () => {
            this._store.togglePin(entry.id);
            this._focusSearch();
        });

        const delBtn = new St.Button({
            style_class: 'smart-clipboard-action-btn smart-clipboard-delete-btn',
            reactive: true,
            accessible_name: 'Delete item',
            child: new St.Icon({
                icon_name: 'edit-delete-symbolic',
                style_class: 'smart-clipboard-action-icon',
            }),
        });
        delBtn.connect('clicked', () => {
            this._store.deleteItem(entry.id);
            this._focusSearch();
        });

        actionsBox.add_child(pinBtn);
        actionsBox.add_child(delBtn);

        row.add_child(contentBox);
        row.add_child(actionsBox);

        row.connect('enter-event', () => {
            if (this._selectedIndex !== index) {
                this._selectedIndex = index;
                this._updateSelectionHighlight();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        row.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._activateEntry(entry);
            return Clutter.EVENT_STOP;
        });

        return row;
    }

    _updateSelectionHighlight() {
        for (let i = 0; i < this._rows.length; i++) {
            const row = this._rows[i];
            if (i === this._selectedIndex)
                row.add_style_class_name('smart-clipboard-row-selected');
            else
                row.remove_style_class_name('smart-clipboard-row-selected');
        }
    }

    _scrollSelectedIntoView() {
        if (this._selectedIndex < 0 || this._selectedIndex >= this._rows.length)
            return;

        const row = this._rows[this._selectedIndex];
        const vadj = this._scrollView.vadjustment;
        if (!vadj || !row)
            return;

        const box = row.get_allocation_box();
        const top = box.y1;
        const bottom = box.y2;
        if (bottom <= top)
            return;

        const viewTop = vadj.value;
        const viewBottom = viewTop + vadj.page_size;

        if (top < viewTop)
            vadj.value = top;
        else if (bottom > viewBottom)
            vadj.value = bottom - vadj.page_size;
    }

    _moveSelection(delta) {
        const count = this._filteredEntries.length;
        if (count === 0)
            return;

        if (this._selectedIndex < 0)
            this._selectedIndex = 0;
        else
            this._selectedIndex = (this._selectedIndex + delta + count) % count;

        this._updateSelectionHighlight();
        this._scrollSelectedIntoView();
    }

    _activateSelected() {
        if (this._selectedIndex < 0 || this._selectedIndex >= this._filteredEntries.length)
            return;
        this._activateEntry(this._filteredEntries[this._selectedIndex]);
    }

    _activateEntry(entry) {
        if (!entry)
            return;
        this.menu.close();
        this._onSelectEntry?.(entry);
    }

    _deleteSelected() {
        if (this._selectedIndex < 0 || this._selectedIndex >= this._filteredEntries.length)
            return;
        const entry = this._filteredEntries[this._selectedIndex];
        this._store.deleteItem(entry.id);
    }

    _onCapturedEvent(event) {
        if (this._destroyed || !this.menu.isOpen)
            return Clutter.EVENT_PROPAGATE;
        if (event.type() !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;

        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

        if (symbol === Clutter.KEY_Escape) {
            this.menu.close();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Down || (ctrl && symbol === Clutter.KEY_n)) {
            this._moveSelection(1);
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Up || (ctrl && symbol === Clutter.KEY_p)) {
            this._moveSelection(-1);
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            this._activateSelected();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Delete || symbol === Clutter.KEY_KP_Delete) {
            const clutterText = this._searchEntry.clutter_text;
            const textLen = this._searchEntry.get_text().length;
            const cursorPos = clutterText.get_cursor_position();
            const atEnd = cursorPos === -1 || cursorPos >= textLen;
            if (shift || atEnd) {
                this._deleteSelected();
                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onMenuOpened() {
        if (this._searchEntry.get_text().length > 0)
            this._searchEntry.set_text('');
        this._selectedIndex = 0;
        this.refresh();
        if (this._scrollView.vadjustment)
            this._scrollView.vadjustment.value = 0;
        this._focusSearch();
    }

    _focusSearch() {
        this._cancelFocusIdle();
        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusIdleId = 0;
            if (!this._destroyed && this.menu.isOpen)
                this._searchEntry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelFocusIdle() {
        if (this._focusIdleId !== 0) {
            GLib.Source.remove(this._focusIdleId);
            this._focusIdleId = 0;
        }
    }

    destroy() {
        this._destroyed = true;
        this._cancelFocusIdle();

        if (this._menuOpenId && this.menu) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = 0;
        }
        if (this._capturedEventId && this.menu?.actor) {
            this.menu.actor.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }
        if (this._searchTextChangedId && this._searchEntry?.clutter_text) {
            this._searchEntry.clutter_text.disconnect(this._searchTextChangedId);
            this._searchTextChangedId = 0;
        }
        if (this._searchSecondaryClickId && this._searchEntry) {
            this._searchEntry.disconnect(this._searchSecondaryClickId);
            this._searchSecondaryClickId = 0;
        }

        this._rows = [];
        this._filteredEntries = [];
        this._store = null;
        this._onSelectEntry = null;
        this._onTogglePause = null;
        this._onOpenPreferences = null;

        super.destroy();
    }
});
