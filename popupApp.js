#!/usr/bin/env gjs -m
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import {
    POPUP_APP_ID,
    POPUP_IFACE_XML,
    POPUP_OBJECT_PATH,
} from './dbusService.js';
import {
    ClipboardServiceClient,
    PIN_DRAG_MIME,
    buildDragContentProvider,
    filterEntries,
    formatBytes,
    formatRelativeTime,
    formatTextPreview,
    parseCssColor,
} from './popupClient.js';

const FEATURED_COUNT = 3;
const DECODER = new TextDecoder('utf-8');
const MODULE_DIR = Gio.File.new_for_uri(import.meta.url).get_parent().get_path();

class SmartClipboardPopupApp {
    #app;
    #window = null;
    #toastOverlay = null;
    #searchEntry = null;
    #pausedBanner = null;
    #listBox = null;
    #emptyStack = null;
    #pauseToggleBtn = null;
    #clearBtn = null;

    #client = null;
    #dbusExport = null;

    #entries = [];
    #filtered = [];
    #paused = false;
    #isDragging = false;
    #inModal = false;
    #syncingToggles = false;
    #hideTimerId = 0;

    constructor() {
        this.#app = new Adw.Application({
            application_id: POPUP_APP_ID,
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
        });
        this.#app.connect('startup', () => this.#onStartup());
        this.#app.connect('activate', () => this.#showWindow());
        this.#app.connect('shutdown', () => this.#onShutdown());
    }

    run(argv) {
        return this.#app.run(argv);
    }

    #onStartup() {
        this.#app.hold();
        this.#loadCss();
        this.#buildWindow();

        this.#client = new ClipboardServiceClient({
            onChanged: () => this.#refreshFromExtension(),
        });

        this.#dbusExport = Gio.DBusExportedObject.wrapJSObject(POPUP_IFACE_XML, {
            Toggle: () => this.#toggleWindow(),
            Show: () => this.#showWindow(),
            Hide: () => this.#hideWindow(),
            Quit: () => this.#quitApp(),
        });
        this.#dbusExport.export(Gio.DBus.session, POPUP_OBJECT_PATH);
    }

    #loadCss() {
        const display = Gdk.Display.get_default();
        if (!display)
            return;
        const provider = new Gtk.CssProvider();
        provider.load_from_path(GLib.build_filenamev([MODULE_DIR, 'popup.css']));
        Gtk.StyleContext.add_provider_for_display(
            display,
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
    }

    #buildWindow() {
        this.#window = new Adw.ApplicationWindow({
            application: this.#app,
            title: 'Smart Clipboard',
            default_width: 480,
            default_height: 700,
            resizable: true,
            css_classes: ['sc-window'],
        });

        this.#window.connect('close-request', () => {
            this.#hideWindow();
            return true;
        });

        this.#window.connect('notify::is-active', () => {
            if (!this.#window.is_active)
                this.#scheduleFocusAutoHide();
            else
                this.#cancelFocusAutoHide();
        });

        const keyCtrl = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        keyCtrl.connect('key-pressed', (_ctrl, keyval, _keycode, state) =>
            this.#onKeyPressed(keyval, state));
        this.#window.add_controller(keyCtrl);

        const toolbarView = new Adw.ToolbarView();
        toolbarView.add_top_bar(this.#buildHeaderBar());

        const body = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
        });

        this.#pausedBanner = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            css_classes: ['sc-paused-banner'],
            visible: false,
        });
        this.#pausedBanner.append(new Gtk.Image({icon_name: 'action-unavailable-symbolic'}));
        this.#pausedBanner.append(new Gtk.Label({
            label: 'Private Mode active — new copies are paused',
            xalign: 0,
            hexpand: true,
        }));
        body.append(this.#pausedBanner);

        this.#emptyStack = new Gtk.Stack({hexpand: true, vexpand: true});

        const scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
        });

        this.#listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            activate_on_single_click: true,
            css_classes: ['sc-list'],
        });
        this.#listBox.connect('row-activated', (_lb, row) => {
            if (row?._scEntry)
                this.#activateEntry(row._scEntry);
        });
        scroller.set_child(this.#listBox);

        const emptyPage = new Adw.StatusPage({
            icon_name: 'edit-paste-symbolic',
            title: 'Clipboard is empty',
            description: 'Copy any text or image to see it here.',
        });

        this.#emptyStack.add_named(scroller, 'list');
        this.#emptyStack.add_named(emptyPage, 'empty');
        body.append(this.#emptyStack);

        this.#toastOverlay = new Adw.ToastOverlay({child: body});
        toolbarView.set_content(this.#toastOverlay);
        this.#window.set_content(toolbarView);
    }

    #buildHeaderBar() {
        const header = new Adw.HeaderBar();

        this.#searchEntry = new Gtk.SearchEntry({
            placeholder_text: 'Search clipboard…',
            hexpand: true,
            css_classes: ['sc-search-entry'],
        });
        this.#searchEntry.connect('search-changed', () => this.#rebuildList());
        header.set_title_widget(this.#searchEntry);

        this.#pauseToggleBtn = new Gtk.ToggleButton({
            icon_name: 'action-unavailable-symbolic',
            tooltip_text: 'Private Mode (pause recording)',
        });
        this.#pauseToggleBtn.connect('toggled', () => {
            if (this.#syncingToggles)
                return;
            this.#client?.setPaused(this.#pauseToggleBtn.get_active()).catch(() => {});
        });

        this.#clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-all-symbolic',
            tooltip_text: 'Clear unpinned history',
        });
        this.#clearBtn.connect('clicked', () => this.#clearUnpinned());

        const prefsBtn = new Gtk.Button({
            icon_name: 'preferences-system-symbolic',
            tooltip_text: 'Preferences',
        });
        prefsBtn.connect('clicked', () => {
            this.#hideWindow();
            this.#client?.openPreferences().catch(() => {});
        });

        header.pack_end(prefsBtn);
        header.pack_end(this.#clearBtn);
        header.pack_end(this.#pauseToggleBtn);
        return header;
    }

    async #refreshFromExtension() {
        try {
            const state = await this.#client.getState();
            this.#entries = Array.isArray(state.entries) ? state.entries : [];
            this.#paused = Boolean(state.paused);

            this.#syncingToggles = true;
            this.#pauseToggleBtn.set_active(this.#paused);
            this.#syncingToggles = false;

            this.#pausedBanner.set_visible(this.#paused);
            this.#clearBtn.set_sensitive(this.#entries.some(e => !e.pinned));
            this.#rebuildList();
        } catch (e) {
            console.warn(`[smart-clipboard-popup] State sync failed: ${e.message}`);
        }
    }

    #rebuildList() {
        const query = this.#searchEntry.get_text();
        this.#filtered = filterEntries(this.#entries, query);

        let child = this.#listBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.#listBox.remove(child);
            child = next;
        }

        if (this.#filtered.length === 0) {
            this.#emptyStack.set_visible_child_name('empty');
            return;
        }

        this.#emptyStack.set_visible_child_name('list');

        this.#filtered.forEach((entry, idx) => {
            const featured = idx < FEATURED_COUNT;
            this.#listBox.append(this.#createCardRow(entry, featured));
        });

        const firstRow = this.#listBox.get_row_at_index(0);
        if (firstRow)
            this.#listBox.select_row(firstRow);
    }

    #createCardRow(entry, featured) {
        const classes = [];
        if (featured)
            classes.push('sc-row-featured');
        if (entry.pinned)
            classes.push('sc-row-pinned');

        const row = new Gtk.ListBoxRow({css_classes: classes});
        row._scEntry = entry;

        const card = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: featured ? 8 : 4,
            hexpand: true,
        });

        // Top preview body
        if (featured)
            card.append(this.#buildFeaturedBody(entry));
        else
            card.append(this.#buildCompactBody(entry));

        // Bottom meta + explicit Copy / Pin / Preview / Delete bar
        card.append(this.#buildCardFooter(entry));

        row.set_child(card);
        this.#attachRowDragAndDrop(row, entry);
        return row;
    }

    #buildFeaturedBody(entry) {
        if (entry.type === 'image') {
            const frame = new Gtk.Box({
                css_classes: ['sc-featured-image'],
                hexpand: true,
                overflow: Gtk.Overflow.HIDDEN,
            });
            const pic = new Gtk.Picture({
                content_fit: Gtk.ContentFit.CONTAIN,
                can_shrink: true,
                hexpand: true,
                height_request: 170,
            });
            const path = entry.imagePath || entry.thumbPath;
            if (path) {
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null))
                    pic.set_file(file);
            }
            frame.append(pic);
            return frame;
        }

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
        });

        if (entry.subtype === 'color') {
            const swatch = this.#makeColorSwatch(entry.colorValue || entry.text, 'sc-color-swatch-big');
            if (swatch)
                box.append(swatch);
        }

        const label = new Gtk.Label({
            label: formatTextPreview(entry.text, 5, 360),
            xalign: 0,
            lines: 5,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
            css_classes: entry.subtype === 'code'
                ? ['sc-card-text-big', 'monospace']
                : ['sc-card-text-big'],
        });
        box.append(label);
        return box;
    }

    #buildCompactBody(entry) {
        const hbox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            hexpand: true,
        });

        if (entry.type === 'image') {
            const pic = new Gtk.Picture({
                content_fit: Gtk.ContentFit.COVER,
                can_shrink: true,
                width_request: 68,
                height_request: 44,
                css_classes: ['sc-compact-thumb'],
                overflow: Gtk.Overflow.HIDDEN,
            });
            const path = entry.thumbPath || entry.imagePath;
            if (path) {
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null))
                    pic.set_file(file);
            }
            hbox.append(pic);
            hbox.append(new Gtk.Label({
                label: entry.width && entry.height ? `Image ${entry.width}×${entry.height}` : 'Image',
                xalign: 0,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                css_classes: ['sc-card-text-compact'],
            }));
            return hbox;
        }

        if (entry.subtype === 'color') {
            const dot = this.#makeColorSwatch(entry.colorValue || entry.text, 'sc-color-swatch-small');
            if (dot) {
                dot.set_valign(Gtk.Align.CENTER);
                hbox.append(dot);
            }
        }

        hbox.append(new Gtk.Label({
            label: formatTextPreview(entry.text, 2, 130),
            xalign: 0,
            lines: 2,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
            hexpand: true,
            css_classes: entry.subtype === 'code'
                ? ['sc-card-text-compact', 'monospace']
                : ['sc-card-text-compact'],
        }));
        return hbox;
    }

    #buildCardFooter(entry) {
        const footer = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
        });

        footer.append(new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            pixel_size: 13,
            valign: Gtk.Align.CENTER,
            css_classes: ['sc-drag-handle'],
            tooltip_text: 'Drag into any app',
        }));

        const meta = [];
        if (entry.type === 'image') {
            if (entry.width && entry.height)
                meta.push(`${entry.width}×${entry.height}`);
            meta.push(formatBytes(entry.sizeBytes));
        } else {
            meta.push(`${entry.charCount} chars`);
            if (entry.lineCount > 1)
                meta.push(`${entry.lineCount} lines`);
        }
        if (entry.sourceApp)
            meta.push(entry.sourceApp);
        const rel = formatRelativeTime(entry.updatedAt);
        if (rel)
            meta.push(rel);

        footer.append(new Gtk.Label({
            label: meta.join(' · '),
            xalign: 0,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
            valign: Gtk.Align.CENTER,
            css_classes: ['sc-card-meta'],
        }));

        const actions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            valign: Gtk.Align.CENTER,
            css_classes: ['sc-card-actions'],
        });

        const copyBtn = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            css_classes: ['flat'],
            tooltip_text: 'Copy',
        });
        copyBtn.connect('clicked', () => this.#copyEntryOnly(entry));

        const pinBtn = new Gtk.Button({
            icon_name: 'view-pin-symbolic',
            css_classes: entry.pinned ? ['flat', 'sc-pin-active'] : ['flat'],
            tooltip_text: entry.pinned ? 'Unpin' : 'Pin',
        });
        pinBtn.connect('clicked', () => this.#togglePin(entry.id));

        const previewBtn = new Gtk.Button({
            icon_name: 'view-reveal-symbolic',
            css_classes: ['flat'],
            tooltip_text: 'Full preview',
        });
        previewBtn.connect('clicked', () => this.#openPreviewDialog(entry));

        const delBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            css_classes: ['flat', 'sc-danger-btn'],
            tooltip_text: 'Delete',
        });
        delBtn.connect('clicked', () => this.#deleteEntry(entry.id));

        actions.append(copyBtn);
        actions.append(pinBtn);
        actions.append(previewBtn);
        actions.append(delBtn);
        footer.append(actions);
        return footer;
    }

    #makeColorSwatch(colorStr, cssClass) {
        const parsed = parseCssColor(colorStr);
        if (!parsed || !/^[#a-zA-Z0-9(),.%\s/+-]+$/.test(parsed.css))
            return null;
        const box = new Gtk.Box({css_classes: [cssClass]});
        const prov = new Gtk.CssProvider();
        prov.load_from_string(`.${cssClass} { background-color: ${parsed.css}; }`);
        box.get_style_context().add_provider(prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        return box;
    }

    #openPreviewDialog(entry) {
        this.#inModal = true;
        this.#cancelFocusAutoHide();

        const dialog = new Adw.Dialog({
            title: entry.type === 'image'
                ? `Image${entry.width && entry.height ? ` (${entry.width}×${entry.height})` : ''}`
                : 'Clipboard Preview',
            content_width: 560,
            content_height: 460,
        });

        const view = new Adw.ToolbarView();
        view.add_top_bar(new Adw.HeaderBar());

        const body = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            css_classes: ['sc-dialog-body'],
            hexpand: true,
            vexpand: true,
        });

        if (entry.type === 'image') {
            const stage = new Gtk.Box({
                css_classes: ['sc-dialog-image'],
                hexpand: true,
                vexpand: true,
            });
            const pic = new Gtk.Picture({
                content_fit: Gtk.ContentFit.CONTAIN,
                can_shrink: true,
                hexpand: true,
                vexpand: true,
            });
            const path = entry.imagePath || entry.thumbPath;
            if (path) {
                const f = Gio.File.new_for_path(path);
                if (f.query_exists(null))
                    pic.set_file(f);
            }
            stage.append(pic);
            body.append(stage);
        } else {
            const scroller = new Gtk.ScrolledWindow({
                hexpand: true,
                vexpand: true,
                css_classes: ['sc-dialog-text'],
            });
            const buffer = new Gtk.TextBuffer();
            buffer.set_text(entry.text, -1);
            const textView = new Gtk.TextView({
                buffer,
                editable: false,
                wrap_mode: Gtk.WrapMode.WORD_CHAR,
                top_margin: 10,
                bottom_margin: 10,
                left_margin: 12,
                right_margin: 12,
                css_classes: entry.subtype === 'code' ? ['monospace'] : [],
            });
            scroller.set_child(textView);
            body.append(scroller);
        }

        const btnBar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.END,
        });

        if (entry.type === 'text' && (entry.isUrl || entry.subtype === 'url')) {
            const openUrlBtn = new Gtk.Button({label: 'Open Link'});
            openUrlBtn.connect('clicked', () => {
                Gio.AppInfo.launch_default_for_uri_async(entry.text.trim(), null, null, null);
                dialog.close();
            });
            btnBar.append(openUrlBtn);
        }

        const pinBtn = new Gtk.Button({
            label: entry.pinned ? 'Unpin' : 'Pin',
            icon_name: 'view-pin-symbolic',
        });
        pinBtn.connect('clicked', () => {
            this.#togglePin(entry.id);
            dialog.close();
        });

        const copyBtn = new Gtk.Button({
            label: 'Copy',
            icon_name: 'edit-copy-symbolic',
            css_classes: ['suggested-action'],
        });
        copyBtn.connect('clicked', () => {
            dialog.close();
            this.#activateEntry(entry);
        });

        btnBar.append(pinBtn);
        btnBar.append(copyBtn);
        body.append(btnBar);

        view.set_content(body);
        dialog.set_child(view);
        dialog.connect('closed', () => {
            this.#inModal = false;
        });
        dialog.present(this.#window);
    }

    #attachRowDragAndDrop(row, entry) {
        const dragSource = new Gtk.DragSource({
            actions: entry.pinned
                ? (Gdk.DragAction.COPY | Gdk.DragAction.MOVE)
                : Gdk.DragAction.COPY,
        });

        dragSource.connect('prepare', () =>
            buildDragContentProvider(entry, Gdk, {includePinOrder: Boolean(entry.pinned)}));

        dragSource.connect('drag-begin', (src, drag) => {
            this.#isDragging = true;
            this.#cancelFocusAutoHide();
            if (entry.type === 'image') {
                const path = entry.thumbPath || entry.imagePath;
                if (path) {
                    try {
                        src.set_icon(Gdk.Texture.new_from_filename(path), 12, 12);
                        return;
                    } catch {
                        // fallback to label badge
                    }
                }
            }
            const icon = Gtk.DragIcon.get_for_drag(drag);
            if (icon) {
                icon.set_child(new Gtk.Label({
                    label: entry.type === 'image' ? 'Image' : formatTextPreview(entry.text, 1, 40),
                    css_classes: ['sc-drag-badge'],
                }));
            }
        });

        dragSource.connect('drag-end', () => {
            this.#isDragging = false;
        });
        dragSource.connect('drag-cancel', () => {
            this.#isDragging = false;
            return false;
        });
        row.add_controller(dragSource);

        if (entry.pinned) {
            const dropTarget = Gtk.DropTargetAsync.new(
                Gdk.ContentFormats.new([PIN_DRAG_MIME]),
                Gdk.DragAction.MOVE
            );
            dropTarget.connect('drag-enter', () => {
                row.add_css_class('sc-drop-target');
                return Gdk.DragAction.MOVE;
            });
            dropTarget.connect('drag-motion', () => Gdk.DragAction.MOVE);
            dropTarget.connect('drag-leave', () => row.remove_css_class('sc-drop-target'));
            dropTarget.connect('drop', (_target, drop) => {
                row.remove_css_class('sc-drop-target');
                drop.read_async([PIN_DRAG_MIME], GLib.PRIORITY_DEFAULT, null, (d, res) => {
                    try {
                        const [stream] = d.read_finish(res);
                        const bytes = stream.read_bytes(256, null);
                        const sourceId = DECODER.decode(bytes.get_data()).trim();
                        stream.close(null);
                        d.finish(Gdk.DragAction.MOVE);
                        if (sourceId && sourceId !== entry.id)
                            this.#client?.reorderPinned(sourceId, entry.id).catch(() => {});
                    } catch {
                        d.finish(0);
                    }
                });
                return true;
            });
            row.add_controller(dropTarget);
        }
    }

    #moveSelection(delta) {
        if (this.#filtered.length === 0)
            return;
        const current = this.#listBox.get_selected_row();
        const curIdx = current ? current.get_index() : -1;
        const nextIdx = Math.max(0, Math.min(this.#filtered.length - 1, curIdx + delta));
        const target = this.#listBox.get_row_at_index(nextIdx);
        if (target) {
            this.#listBox.select_row(target);
            target.grab_focus();
            this.#searchEntry.grab_focus();
        }
    }

    #onKeyPressed(keyval, state) {
        if (this.#inModal)
            return false;

        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;

        if (keyval === Gdk.KEY_Escape) {
            if (this.#searchEntry.get_text().length > 0) {
                this.#searchEntry.set_text('');
                return true;
            }
            this.#hideWindow();
            return true;
        }

        if (keyval === Gdk.KEY_Down || (ctrl && keyval === Gdk.KEY_n)) {
            this.#moveSelection(1);
            return true;
        }
        if (keyval === Gdk.KEY_Up) {
            this.#moveSelection(-1);
            return true;
        }

        const selected = this.#listBox.get_selected_row()?._scEntry ?? null;
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            if (selected) {
                this.#activateEntry(selected);
                return true;
            }
        }
        if (ctrl && keyval === Gdk.KEY_p && selected) {
            this.#togglePin(selected.id);
            return true;
        }
        if (ctrl && keyval === Gdk.KEY_z && this.#searchEntry.get_text().length === 0) {
            this.#undoDelete();
            return true;
        }
        if ((keyval === Gdk.KEY_Delete || keyval === Gdk.KEY_KP_Delete) &&
            selected && this.#searchEntry.get_text().length === 0) {
            this.#deleteEntry(selected.id);
            return true;
        }
        return false;
    }

    async #activateEntry(entry) {
        if (!entry)
            return;
        this.#hideWindow();
        try {
            await this.#client.copyEntry(entry.id, true);
        } catch (e) {
            console.warn(`[smart-clipboard-popup] Copy failed: ${e.message}`);
        }
    }

    async #copyEntryOnly(entry) {
        if (!entry)
            return;
        try {
            const ok = await this.#client.copyEntry(entry.id, false);
            if (ok)
                this.#showToast('Copied');
        } catch (e) {
            this.#showToast(`Copy failed: ${e.message}`);
        }
    }

    async #togglePin(id) {
        try {
            const pinned = await this.#client.togglePin(id);
            this.#showToast(pinned ? 'Pinned' : 'Unpinned');
        } catch (e) {
            this.#showToast(`Pin failed: ${e.message}`);
        }
    }

    async #deleteEntry(id) {
        try {
            const ok = await this.#client.deleteEntry(id);
            if (ok)
                this.#showUndoToast('Item deleted');
        } catch (e) {
            this.#showToast(`Delete failed: ${e.message}`);
        }
    }

    async #clearUnpinned() {
        try {
            const count = await this.#client.clearUnpinned();
            if (count > 0)
                this.#showUndoToast(`Cleared ${count} ${count === 1 ? 'item' : 'items'}`);
        } catch (e) {
            this.#showToast(`Clear failed: ${e.message}`);
        }
    }

    async #undoDelete() {
        try {
            const restored = await this.#client.undoDelete();
            if (restored > 0)
                this.#showToast(`Restored ${restored}`);
        } catch {
            // ignore
        }
    }

    #showToast(message) {
        this.#toastOverlay?.add_toast(new Adw.Toast({title: message, timeout: 2}));
    }

    #showUndoToast(message) {
        const toast = new Adw.Toast({
            title: message,
            button_label: 'Undo',
            timeout: 5,
        });
        toast.connect('button-clicked', () => this.#undoDelete());
        this.#toastOverlay?.add_toast(toast);
    }

    #scheduleFocusAutoHide() {
        this.#cancelFocusAutoHide();
        if (this.#isDragging || this.#inModal)
            return;
        this.#hideTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => {
            this.#hideTimerId = 0;
            if (this.#window?.visible && !this.#window.is_active && !this.#isDragging && !this.#inModal)
                this.#hideWindow();
            return GLib.SOURCE_REMOVE;
        });
    }

    #cancelFocusAutoHide() {
        if (this.#hideTimerId !== 0) {
            GLib.Source.remove(this.#hideTimerId);
            this.#hideTimerId = 0;
        }
    }

    #toggleWindow() {
        if (this.#window?.visible)
            this.#hideWindow();
        else
            this.#showWindow();
    }

    #showWindow() {
        if (!this.#window)
            return;
        this.#cancelFocusAutoHide();
        this.#searchEntry.set_text('');
        this.#refreshFromExtension();
        this.#window.present();
        this.#searchEntry.grab_focus();
    }

    #hideWindow() {
        this.#cancelFocusAutoHide();
        this.#window?.set_visible(false);
    }

    #quitApp() {
        this.#cancelFocusAutoHide();
        this.#app.release();
        this.#app.quit();
    }

    #onShutdown() {
        this.#cancelFocusAutoHide();
        if (this.#dbusExport) {
            try {
                this.#dbusExport.unexport();
            } catch {
                // ignore
            }
            this.#dbusExport = null;
        }
        if (this.#client) {
            this.#client.destroy();
            this.#client = null;
        }
    }
}

const app = new SmartClipboardPopupApp();
app.run([import.meta.url, ...ARGV]);
