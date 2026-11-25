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
    transformText,
} from './popupClient.js';
import {PreviewPane} from './popupPreview.js';

const CATEGORIES = [
    {id: 'all', label: 'All'},
    {id: 'pinned', label: 'Pinned'},
    {id: 'text', label: 'Text'},
    {id: 'image', label: 'Images'},
    {id: 'url', label: 'Links'},
    {id: 'code', label: 'Code'},
    {id: 'color', label: 'Colors'},
];

const DECODER = new TextDecoder('utf-8');
const MODULE_DIR = Gio.File.new_for_uri(import.meta.url).get_parent().get_path();

class SmartClipboardPopupApp {
    #app;
    #window = null;
    #toastOverlay = null;
    #titleWidget = null;
    #paned = null;
    #searchEntry = null;
    #pausedBanner = null;
    #listBox = null;
    #emptyStack = null;
    #preview = null;
    #keepOpenBtn = null;
    #previewToggleBtn = null;
    #pauseToggleBtn = null;
    #clearBtn = null;
    #filterButtons = new Map();

    #client = null;
    #dbusExport = null;

    #entries = [];
    #filtered = [];
    #category = 'all';
    #selectedId = null;
    #paused = false;
    #autoPaste = true;
    #showPreview = true;
    #keepOpen = false;
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
            default_width: 860,
            default_height: 560,
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

        // Global window key controller
        const keyCtrl = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        keyCtrl.connect('key-pressed', (_ctrl, keyval, _keycode, state) =>
            this.#onKeyPressed(keyval, state));
        this.#window.add_controller(keyCtrl);

        const toolbarView = new Adw.ToolbarView();
        toolbarView.add_top_bar(this.#buildHeaderBar());

        // Split layout: left list + right live preview
        this.#paned = new Gtk.Paned({
            orientation: Gtk.Orientation.HORIZONTAL,
            shrink_start_child: false,
            shrink_end_child: false,
            resize_start_child: true,
            resize_end_child: true,
            position: 410,
            hexpand: true,
            vexpand: true,
        });

        this.#paned.set_start_child(this.#buildLeftPane());
        this.#preview = new PreviewPane({
            onPaste: entry => this.#activateEntry(entry, true),
            onCopy: entry => this.#copyEntryOnly(entry),
            onCopyTransformed: (text, toastMsg) => this.#copyPlainText(text, false, toastMsg),
            onTogglePin: entry => this.#togglePin(entry.id),
            onSaveEdit: (id, newText) => this.#saveEdit(id, newText),
            onDelete: entry => this.#deleteEntry(entry.id),
            onToast: msg => this.#showToast(msg),
            onDragStateChanged: dragging => {
                this.#isDragging = dragging;
                if (dragging)
                    this.#cancelFocusAutoHide();
            },
            onModalStateChanged: open => {
                this.#inModal = open;
                if (open)
                    this.#cancelFocusAutoHide();
            },
        });
        this.#paned.set_end_child(this.#preview.widget);

        this.#toastOverlay = new Adw.ToastOverlay({
            child: this.#paned,
        });
        toolbarView.set_content(this.#toastOverlay);
        this.#window.set_content(toolbarView);
    }

    #buildHeaderBar() {
        const header = new Adw.HeaderBar();

        this.#titleWidget = new Adw.WindowTitle({
            title: 'Smart Clipboard',
            subtitle: '',
        });
        header.set_title_widget(this.#titleWidget);

        this.#keepOpenBtn = new Gtk.ToggleButton({
            icon_name: 'view-pin-symbolic',
            tooltip_text: 'Keep window open while dragging & dropping',
        });
        this.#keepOpenBtn.connect('toggled', () => {
            if (this.#syncingToggles)
                return;
            this.#keepOpen = this.#keepOpenBtn.get_active();
            this.#client?.setKeepOpen(this.#keepOpen).catch(() => {});
            this.#showToast(this.#keepOpen
                ? 'Window pinned open — drag freely into other apps'
                : 'Auto-hide on focus loss restored');
        });

        this.#previewToggleBtn = new Gtk.ToggleButton({
            icon_name: 'sidebar-show-right-symbolic',
            active: true,
            tooltip_text: 'Toggle preview pane (Ctrl+\\)',
        });
        this.#previewToggleBtn.connect('toggled', () => {
            if (this.#syncingToggles)
                return;
            this.#applyPreviewVisible(this.#previewToggleBtn.get_active(), true);
        });

        header.pack_start(this.#keepOpenBtn);
        header.pack_start(this.#previewToggleBtn);

        this.#pauseToggleBtn = new Gtk.ToggleButton({
            icon_name: 'action-unavailable-symbolic',
            tooltip_text: 'Private Mode — pause clipboard recording',
        });
        this.#pauseToggleBtn.connect('toggled', () => {
            if (this.#syncingToggles)
                return;
            this.#client?.setPaused(this.#pauseToggleBtn.get_active()).catch(() => {});
        });

        this.#clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-all-symbolic',
            tooltip_text: 'Clear all unpinned items',
        });
        this.#clearBtn.connect('clicked', () => this.#clearUnpinned());

        const helpBtn = new Gtk.MenuButton({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            tooltip_text: 'Keyboard shortcuts',
            popover: this.#buildShortcutsPopover(),
        });

        const prefsBtn = new Gtk.Button({
            icon_name: 'preferences-system-symbolic',
            tooltip_text: 'Preferences',
        });
        prefsBtn.connect('clicked', () => {
            this.#hideWindow();
            this.#client?.openPreferences().catch(() => {});
        });

        header.pack_end(prefsBtn);
        header.pack_end(helpBtn);
        header.pack_end(this.#clearBtn);
        header.pack_end(this.#pauseToggleBtn);

        return header;
    }

    #buildShortcutsPopover() {
        const popover = new Gtk.Popover();
        const grid = new Gtk.Grid({
            column_spacing: 16,
            row_spacing: 6,
            css_classes: ['sc-shortcuts-grid'],
        });
        const shortcuts = [
            ['Enter / Double-click', 'Paste (or copy & close)'],
            ['Shift + Enter', 'Paste as clean single-line text'],
            ['Ctrl + C', 'Copy without closing'],
            ['Ctrl + P', 'Pin / unpin selected'],
            ['Ctrl + E', 'Edit selected text inline'],
            ['Ctrl + \\', 'Toggle preview pane'],
            ['Alt + 1…9', 'Instant paste item #1–9'],
            ['Ctrl + 1…7', 'Switch category filter'],
            ['Delete', 'Delete selected item'],
            ['Ctrl + Z', 'Undo last delete'],
            ['Drag row / preview', 'Drop into any app or reorder pins'],
            ['Escape', 'Clear search or close'],
        ];
        shortcuts.forEach(([key, desc], idx) => {
            grid.attach(new Gtk.Label({label: key, xalign: 0, css_classes: ['caption', 'monospace']}), 0, idx, 1, 1);
            grid.attach(new Gtk.Label({label: desc, xalign: 0, css_classes: ['caption', 'dim-label']}), 1, idx, 1, 1);
        });
        popover.set_child(grid);
        return popover;
    }

    #buildLeftPane() {
        const left = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['sc-left-pane'],
            width_request: 340,
            hexpand: true,
            vexpand: true,
        });

        // Search box
        const searchBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            css_classes: ['sc-search-box'],
        });
        this.#searchEntry = new Gtk.SearchEntry({
            placeholder_text: 'Search history, apps, colors, links…',
            hexpand: true,
        });
        this.#searchEntry.connect('search-changed', () => {
            this.#rebuildList();
        });
        searchBox.append(this.#searchEntry);
        left.append(searchBox);

        // Category filter pills
        const filterScroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
        });
        const filterBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            css_classes: ['sc-filter-bar'],
        });
        for (const cat of CATEGORIES) {
            const btn = new Gtk.ToggleButton({
                label: cat.label,
                active: cat.id === 'all',
                css_classes: ['flat', 'sc-filter-pill'],
            });
            btn.connect('toggled', () => {
                if (!btn.get_active()) {
                    if (this.#category === cat.id)
                        btn.set_active(true);
                    return;
                }
                this.#setCategory(cat.id);
            });
            this.#filterButtons.set(cat.id, btn);
            filterBox.append(btn);
        }
        filterScroll.set_child(filterBox);
        left.append(filterScroll);

        // Private mode banner
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
        left.append(this.#pausedBanner);

        // List / Empty stack
        this.#emptyStack = new Gtk.Stack({
            hexpand: true,
            vexpand: true,
        });

        const listScroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
        });
        this.#listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            activate_on_single_click: false,
            css_classes: ['sc-list'],
        });
        this.#listBox.connect('row-selected', (_lb, row) => {
            const entry = row?._scEntry ?? null;
            this.#selectedId = entry?.id ?? null;
            this.#preview.setEntry(entry);
        });
        this.#listBox.connect('row-activated', (_lb, row) => {
            if (row?._scEntry)
                this.#activateEntry(row._scEntry, true);
        });
        listScroll.set_child(this.#listBox);

        const emptyPage = new Adw.StatusPage({
            icon_name: 'edit-paste-symbolic',
            title: 'Nothing here yet',
            description: 'Copy text, code, links, colors, or images to build your history.',
        });

        this.#emptyStack.add_named(listScroll, 'list');
        this.#emptyStack.add_named(emptyPage, 'empty');
        left.append(this.#emptyStack);

        return left;
    }

    #setCategory(catId) {
        if (this.#category === catId)
            return;
        this.#category = catId;
        for (const [id, btn] of this.#filterButtons) {
            if (btn.get_active() !== (id === catId))
                btn.set_active(id === catId);
        }
        this.#rebuildList();
    }

    #applyPreviewVisible(visible, persist) {
        this.#showPreview = Boolean(visible);
        this.#preview.widget.set_visible(this.#showPreview);
        this.#syncingToggles = true;
        this.#previewToggleBtn.set_active(this.#showPreview);
        this.#syncingToggles = false;

        const targetWidth = this.#showPreview ? 860 : 440;
        this.#window.set_default_size(targetWidth, 560);

        if (persist)
            this.#client?.setShowPreview(this.#showPreview).catch(() => {});
    }

    async #refreshFromExtension() {
        try {
            const state = await this.#client.getState();
            this.#entries = Array.isArray(state.entries) ? state.entries : [];
            this.#paused = Boolean(state.paused);
            this.#autoPaste = state.autoPaste !== undefined ? Boolean(state.autoPaste) : true;
            this.#keepOpen = Boolean(state.keepOpen);

            this.#syncingToggles = true;
            this.#pauseToggleBtn.set_active(this.#paused);
            this.#keepOpenBtn.set_active(this.#keepOpen);
            this.#syncingToggles = false;

            if (typeof state.showPreview === 'boolean' && state.showPreview !== this.#showPreview)
                this.#applyPreviewVisible(state.showPreview, false);

            this.#pausedBanner.set_visible(this.#paused);
            this.#preview.setAutoPaste(this.#autoPaste);

            const pinnedCount = this.#entries.filter(e => e.pinned).length;
            const total = this.#entries.length;
            this.#titleWidget.set_subtitle(
                pinnedCount > 0 ? `${total} items · ${pinnedCount} pinned` : `${total} items`
            );
            this.#clearBtn.set_sensitive(this.#entries.some(e => !e.pinned));
            this.#rebuildList();
        } catch (e) {
            console.warn(`[smart-clipboard-popup] State sync failed: ${e.message}`);
        }
    }

    #rebuildList() {
        const query = this.#searchEntry.get_text();
        this.#filtered = filterEntries(this.#entries, query, this.#category);

        let child = this.#listBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.#listBox.remove(child);
            child = next;
        }

        if (this.#filtered.length === 0) {
            this.#emptyStack.set_visible_child_name('empty');
            this.#preview.setEntry(null);
            return;
        }

        this.#emptyStack.set_visible_child_name('list');

        let rowToSelect = null;
        this.#filtered.forEach((entry, idx) => {
            const row = this.#createRow(entry, idx);
            this.#listBox.append(row);
            if (entry.id === this.#selectedId)
                rowToSelect = row;
        });

        if (!rowToSelect)
            rowToSelect = this.#listBox.get_row_at_index(0);
        if (rowToSelect)
            this.#listBox.select_row(rowToSelect);
    }

    #createRow(entry, index) {
        const row = new Gtk.ListBoxRow({
            css_classes: entry.pinned ? ['sc-row-pinned'] : [],
        });
        row._scEntry = entry;

        const hbox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
        });

        // Visual drag grip
        hbox.append(new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            pixel_size: 14,
            valign: Gtk.Align.CENTER,
            css_classes: ['sc-drag-handle'],
            tooltip_text: 'Drag into any app',
        }));

        // Optional leading color swatch or image thumbnail
        if (entry.type === 'image') {
            const thumbPath = entry.thumbPath || entry.imagePath;
            const pic = new Gtk.Picture({
                content_fit: Gtk.ContentFit.COVER,
                can_shrink: true,
                width_request: 72,
                height_request: 44,
                css_classes: ['sc-row-thumb'],
                overflow: Gtk.Overflow.HIDDEN,
            });
            if (thumbPath) {
                const f = Gio.File.new_for_path(thumbPath);
                if (f.query_exists(null))
                    pic.set_file(f);
            }
            hbox.append(pic);
        } else if (entry.subtype === 'color') {
            const dot = new Gtk.Box({
                valign: Gtk.Align.CENTER,
                css_classes: ['sc-color-dot'],
            });
            const parsed = parseCssColor(entry.colorValue || entry.text);
            const safeColor = parsed && /^[#a-zA-Z0-9(),.%\s/+-]+$/.test(parsed.css) ? parsed.css : 'transparent';
            const prov = new Gtk.CssProvider();
            prov.load_from_string(`.sc-color-dot { background-color: ${safeColor}; }`);
            dot.get_style_context().add_provider(prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
            hbox.append(dot);
        }

        // Main label + metadata column
        const contentCol = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });

        const titleText = entry.type === 'image'
            ? `Image ${entry.width && entry.height ? `${entry.width}×${entry.height}` : ''}`.trim()
            : formatTextPreview(entry.text, 2, 110);

        const titleLabel = new Gtk.Label({
            label: titleText,
            xalign: 0,
            lines: 2,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
            css_classes: entry.subtype === 'code' ? ['sc-row-title', 'monospace'] : ['sc-row-title'],
        });
        contentCol.append(titleLabel);

        const metaParts = [];
        if (entry.type === 'image') {
            metaParts.push(formatBytes(entry.sizeBytes));
        } else {
            if (entry.isJson)
                metaParts.push('JSON');
            else if (entry.subtype && entry.subtype !== 'text')
                metaParts.push(entry.subtype.toUpperCase());
            metaParts.push(`${entry.charCount} chars`);
        }
        if (entry.sourceApp)
            metaParts.push(entry.sourceApp);
        const rel = formatRelativeTime(entry.updatedAt);
        if (rel)
            metaParts.push(rel);

        contentCol.append(new Gtk.Label({
            label: metaParts.join(' · '),
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            css_classes: ['sc-row-meta'],
        }));
        hbox.append(contentCol);

        // Quick Alt+1..9 hint pill
        if (index < 9) {
            hbox.append(new Gtk.Label({
                label: `⌥${index + 1}`,
                valign: Gtk.Align.CENTER,
                css_classes: ['sc-shortcut-badge'],
                tooltip_text: `Press Alt+${index + 1} to paste`,
            }));
        }

        // Explicit inline action buttons: Copy, Pin, Preview, Delete
        const actions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            valign: Gtk.Align.CENTER,
            css_classes: ['sc-row-actions'],
        });

        const copyBtn = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            css_classes: ['flat'],
            tooltip_text: 'Copy to clipboard',
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
            tooltip_text: 'Preview item',
        });
        previewBtn.connect('clicked', () => {
            this.#listBox.select_row(row);
            if (!this.#showPreview)
                this.#applyPreviewVisible(true, true);
        });

        const delBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            css_classes: ['flat', 'sc-danger-btn'],
            tooltip_text: 'Delete item',
        });
        delBtn.connect('clicked', () => this.#deleteEntry(entry.id));

        actions.append(copyBtn);
        actions.append(pinBtn);
        actions.append(previewBtn);
        actions.append(delBtn);
        hbox.append(actions);

        row.set_child(hbox);

        // Real Wayland/X11 DragSource for dropping into any external app (plus internal pin reorder)
        this.#attachRowDragAndDrop(row, entry);
        return row;
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
                        // fall through to badge
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

        // Pinned rows accept drops from other pinned rows to reorder
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
            dropTarget.connect('drag-leave', () => {
                row.remove_css_class('sc-drop-target');
            });
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

    #getSelectedEntry() {
        const row = this.#listBox.get_selected_row();
        return row?._scEntry ?? null;
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
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
        const alt = (state & Gdk.ModifierType.ALT_MASK) !== 0;

        if (this.#preview.isEditing) {
            if (keyval === Gdk.KEY_Escape) {
                this.#preview.cancelEdit();
                this.#searchEntry.grab_focus();
                return true;
            }
            if (ctrl && (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_s)) {
                this.#preview.commitEdit();
                return true;
            }
            return false;
        }

        if (keyval === Gdk.KEY_Escape) {
            if (this.#searchEntry.get_text().length > 0) {
                this.#searchEntry.set_text('');
                return true;
            }
            this.#hideWindow();
            return true;
        }

        // Alt+1..9 instant paste
        if (alt && keyval >= Gdk.KEY_1 && keyval <= Gdk.KEY_9) {
            const idx = keyval - Gdk.KEY_1;
            if (idx < this.#filtered.length) {
                this.#activateEntry(this.#filtered[idx], true);
                return true;
            }
        }

        // Ctrl+1..7 category switch
        if (ctrl && keyval >= Gdk.KEY_1 && keyval <= Gdk.KEY_7) {
            const idx = keyval - Gdk.KEY_1;
            if (CATEGORIES[idx]) {
                this.#setCategory(CATEGORIES[idx].id);
                return true;
            }
        }

        if (keyval === Gdk.KEY_Down || (ctrl && keyval === Gdk.KEY_n)) {
            this.#moveSelection(1);
            return true;
        }
        if (keyval === Gdk.KEY_Up) {
            this.#moveSelection(-1);
            return true;
        }

        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            const entry = this.#getSelectedEntry();
            if (entry) {
                if (shift && entry.type === 'text')
                    this.#copyPlainText(transformText(entry.text, 'single-line'), true);
                else
                    this.#activateEntry(entry, true);
                return true;
            }
        }

        if (ctrl && keyval === Gdk.KEY_p) {
            const entry = this.#getSelectedEntry();
            if (entry) {
                this.#togglePin(entry.id);
                return true;
            }
        }

        if (ctrl && keyval === Gdk.KEY_e) {
            const entry = this.#getSelectedEntry();
            if (entry && entry.type === 'text') {
                if (!this.#showPreview)
                    this.#applyPreviewVisible(true, true);
                this.#preview.startEdit();
                return true;
            }
        }

        if (ctrl && keyval === Gdk.KEY_backslash) {
            this.#applyPreviewVisible(!this.#showPreview, true);
            return true;
        }

        if (ctrl && keyval === Gdk.KEY_c) {
            const focus = this.#window.get_focus();
            const isSearchFocused = focus === this.#searchEntry || focus?.get_parent?.() === this.#searchEntry;
            const hasSearchSelection = isSearchFocused && this.#searchEntry.get_selection_bounds?.()[0];
            if (!hasSearchSelection) {
                const entry = this.#getSelectedEntry();
                if (entry) {
                    this.#copyEntryOnly(entry);
                    return true;
                }
            }
        }

        if (ctrl && keyval === Gdk.KEY_z && this.#searchEntry.get_text().length === 0) {
            this.#undoDelete();
            return true;
        }

        if (keyval === Gdk.KEY_Delete || keyval === Gdk.KEY_KP_Delete) {
            const textLen = this.#searchEntry.get_text().length;
            if (shift || textLen === 0) {
                const entry = this.#getSelectedEntry();
                if (entry) {
                    this.#deleteEntry(entry.id);
                    return true;
                }
            }
        }

        return false;
    }

    async #activateEntry(entry, paste) {
        if (!entry)
            return;
        if (!this.#keepOpen)
            this.#hideWindow();
        try {
            await this.#client.copyEntry(entry.id, paste && !this.#keepOpen);
            if (this.#keepOpen)
                this.#showToast('Copied to clipboard');
        } catch (e) {
            this.#showToast(`Copy failed: ${e.message}`);
        }
    }

    async #copyEntryOnly(entry) {
        if (!entry)
            return;
        try {
            const ok = await this.#client.copyEntry(entry.id, false);
            if (ok)
                this.#showToast('Copied to clipboard');
        } catch (e) {
            this.#showToast(`Copy failed: ${e.message}`);
        }
    }

    async #copyPlainText(text, closeAndPaste, toastMsg = 'Copied to clipboard') {
        if (closeAndPaste && !this.#keepOpen)
            this.#hideWindow();
        try {
            const ok = await this.#client.copyText(text, closeAndPaste && !this.#keepOpen);
            if (ok && (!closeAndPaste || this.#keepOpen))
                this.#showToast(toastMsg);
        } catch (e) {
            this.#showToast(`Copy failed: ${e.message}`);
        }
    }

    async #togglePin(id) {
        try {
            const pinned = await this.#client.togglePin(id);
            this.#showToast(pinned ? 'Pinned to top' : 'Unpinned');
        } catch (e) {
            this.#showToast(`Pin failed: ${e.message}`);
        }
    }

    async #saveEdit(id, newText) {
        try {
            const ok = await this.#client.updateText(id, newText);
            if (ok)
                this.#showToast('Snippet updated');
        } catch (e) {
            this.#showToast(`Update failed: ${e.message}`);
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
                this.#showUndoToast(`Cleared ${count} unpinned ${count === 1 ? 'item' : 'items'}`);
        } catch (e) {
            this.#showToast(`Clear failed: ${e.message}`);
        }
    }

    async #undoDelete() {
        try {
            const restored = await this.#client.undoDelete();
            if (restored > 0)
                this.#showToast(`Restored ${restored} ${restored === 1 ? 'item' : 'items'}`);
        } catch {
            // ignore
        }
    }

    #showToast(message) {
        if (!this.#toastOverlay)
            return;
        this.#toastOverlay.add_toast(new Adw.Toast({
            title: message,
            timeout: 2,
        }));
    }

    #showUndoToast(message) {
        if (!this.#toastOverlay)
            return;
        const toast = new Adw.Toast({
            title: message,
            button_label: 'Undo',
            timeout: 5,
        });
        toast.connect('button-clicked', () => this.#undoDelete());
        this.#toastOverlay.add_toast(toast);
    }

    #scheduleFocusAutoHide() {
        this.#cancelFocusAutoHide();
        if (this.#keepOpen || this.#isDragging || this.#inModal || this.#preview?.isEditing)
            return;
        this.#hideTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => {
            this.#hideTimerId = 0;
            if (this.#window?.visible &&
                !this.#window.is_active &&
                !this.#keepOpen &&
                !this.#isDragging &&
                !this.#inModal &&
                !this.#preview?.isEditing) {
                this.#hideWindow();
            }
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
        this.#preview.cancelEdit();
        this.#searchEntry.set_text('');
        this.#setCategory('all');
        this.#refreshFromExtension();
        this.#window.present();
        this.#searchEntry.grab_focus();
    }

    #hideWindow() {
        this.#cancelFocusAutoHide();
        if (this.#preview?.isEditing)
            this.#preview.cancelEdit();
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
