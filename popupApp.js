#!/usr/bin/env gjs -m
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
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
    resolveEntryImage,
} from './popupClient.js';

const STRIP_COUNT = 3;
const TILE_W = 182;
const TILE_H = 104;
const THUMB_W = 54;
const THUMB_H = 34;
const MAX_THUMB_CACHE = 36;
const DECODER = new TextDecoder('utf-8');
const MODULE_DIR = Gio.File.new_for_uri(import.meta.url).get_parent().get_path();
const START_HIDDEN = GLib.getenv('SMART_CLIPBOARD_START_HIDDEN') === '1';

function formatShortcutBadge(accel) {
    if (!accel || typeof accel !== 'string')
        return 'Super + V';
    const parts = [];
    const rest = accel.replace(/<([^>]+)>/g, (_m, mod) => {
        const lower = mod.toLowerCase();
        if (lower === 'super' || lower === 'primary')
            parts.push('Super');
        else if (lower === 'control' || lower === 'ctrl')
            parts.push('Ctrl');
        else if (lower === 'shift')
            parts.push('Shift');
        else if (lower === 'alt' || lower === 'mod1')
            parts.push('Alt');
        else
            parts.push(mod);
        return '';
    }).trim();
    if (rest)
        parts.push(rest.length === 1 ? rest.toUpperCase() : rest);
    return parts.length > 0 ? parts.join(' + ') : 'Super + V';
}

function clampBox(child, width, height, cssClasses = []) {
    return new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.NEVER,
        propagate_natural_width: false,
        propagate_natural_height: false,
        kinetic_scrolling: false,
        can_focus: false,
        min_content_width: width,
        min_content_height: height,
        max_content_width: width,
        max_content_height: height,
        width_request: width,
        height_request: height,
        overflow: Gtk.Overflow.HIDDEN,
        css_classes: cssClasses,
        child,
    });
}

class SmartClipboardPopupApp {
    #app;
    #window = null;
    #toastOverlay = null;
    #shortcutLabel = null;
    #expandBtn = null;
    #stripTilesBox = null;
    #textFilterBtn = null;
    #pausedBanner = null;
    #drawerBox = null;
    #searchEntry = null;
    #pauseToggleBtn = null;
    #clearBtn = null;
    #drawerList = null;

    #client = null;
    #dbusExport = null;

    #entries = [];
    #visibleEntries = [];
    #tileWidgets = [];
    #thumbCache = new Map();
    #selectedStripIdx = 0;
    #textOnly = false;
    #expanded = false;
    #paused = false;
    #hasLoadedOnce = false;
    #isDragging = false;
    #inModal = false;
    #syncingToggles = false;
    #suppressFirstActivate = START_HIDDEN;
    #hideTimerId = 0;

    constructor() {
        this.#app = new Adw.Application({
            application_id: POPUP_APP_ID,
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
        });
        this.#app.connect('startup', () => this.#onStartup());
        this.#app.connect('activate', () => {
            if (this.#suppressFirstActivate) {
                this.#suppressFirstActivate = false;
                return;
            }
            this.#showWindow();
        });
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

        // Pre-load entries & pre-render tiles while hidden so first Super+V is instant (<10ms)
        this.#refreshFromExtension();
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

    #getScaledTexture(path) {
        if (!path)
            return null;
        if (this.#thumbCache.has(path))
            return this.#thumbCache.get(path);

        let texture = null;
        try {
            // Decode at 2x tile resolution so big 4K images never stall GPU upload or layout
            const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, TILE_W * 2, TILE_H * 2, true);
            texture = Gdk.Texture.new_for_pixbuf(pb);
        } catch {
            try {
                texture = Gdk.Texture.new_from_filename(path);
            } catch {
                texture = null;
            }
        }

        if (texture) {
            if (this.#thumbCache.size >= MAX_THUMB_CACHE) {
                const oldestKey = this.#thumbCache.keys().next().value;
                this.#thumbCache.delete(oldestKey);
            }
            this.#thumbCache.set(path, texture);
        }
        return texture;
    }

    #buildWindow() {
        this.#window = new Adw.ApplicationWindow({
            application: this.#app,
            title: 'Smart Clipboard',
            decorated: false,
            resizable: false,
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

        const shellWrap = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['sc-shell-wrap'],
        });

        const card = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['sc-shell-card'],
        });

        card.append(this.#buildTopBar());
        card.append(this.#buildPreviewStrip());

        this.#pausedBanner = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            css_classes: ['sc-paused-banner'],
            visible: false,
        });
        this.#pausedBanner.append(new Gtk.Image({icon_name: 'action-unavailable-symbolic'}));
        this.#pausedBanner.append(new Gtk.Label({
            label: 'Private Mode active — clipboard recording paused',
            xalign: 0,
            hexpand: true,
        }));
        card.append(this.#pausedBanner);

        card.append(this.#buildDrawer());

        this.#toastOverlay = new Adw.ToastOverlay({child: card});
        shellWrap.append(this.#toastOverlay);
        this.#window.set_content(shellWrap);
    }

    #buildTopBar() {
        const bar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 7,
            css_classes: ['sc-topbar'],
        });

        bar.append(new Gtk.Image({
            icon_name: 'edit-paste-symbolic',
            pixel_size: 14,
            css_classes: ['sc-brand-icon'],
        }));
        bar.append(new Gtk.Label({
            label: 'Smart Clipboard',
            xalign: 0,
            hexpand: true,
            css_classes: ['sc-brand-title'],
        }));

        this.#shortcutLabel = new Gtk.Label({
            label: 'Super + V',
            css_classes: ['sc-kbd-pill'],
            valign: Gtk.Align.CENTER,
        });
        bar.append(this.#shortcutLabel);

        bar.append(new Gtk.Box({
            css_classes: ['sc-header-sep'],
            valign: Gtk.Align.CENTER,
        }));

        this.#expandBtn = new Gtk.Button({
            icon_name: 'go-next-symbolic',
            css_classes: ['flat', 'sc-expand-btn'],
            tooltip_text: 'Expand full history & search',
        });
        this.#expandBtn.connect('clicked', () => this.#setExpanded(!this.#expanded));
        bar.append(this.#expandBtn);

        return bar;
    }

    #buildPreviewStrip() {
        const strip = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });

        this.#stripTilesBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            homogeneous: true,
        });
        strip.append(this.#stripTilesBox);

        strip.append(new Gtk.Box({
            css_classes: ['sc-strip-sep'],
            vexpand: true,
        }));

        this.#textFilterBtn = new Gtk.ToggleButton({
            css_classes: ['sc-text-filter-tile'],
            tooltip_text: 'Filter text snippets only',
        });
        const textTileInner = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            spacing: 3,
        });
        const glyphBox = new Gtk.Box({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['sc-text-glyph-box'],
        });
        glyphBox.append(new Gtk.Label({
            label: 'T',
            hexpand: true,
            vexpand: true,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['sc-text-glyph'],
        }));
        textTileInner.append(glyphBox);
        textTileInner.append(new Gtk.Label({
            label: 'Text',
            css_classes: ['sc-text-tile-label'],
        }));
        this.#textFilterBtn.set_child(textTileInner);
        this.#textFilterBtn.connect('toggled', () => {
            if (this.#syncingToggles)
                return;
            this.#textOnly = this.#textFilterBtn.get_active();
            this.#selectedStripIdx = 0;
            this.#rebuildUI();
        });
        strip.append(this.#textFilterBtn);

        return strip;
    }

    #buildDrawer() {
        this.#drawerBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['sc-drawer'],
            visible: false,
        });

        const controls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
        });

        this.#searchEntry = new Gtk.SearchEntry({
            placeholder_text: 'Search clipboard history…',
            hexpand: true,
            css_classes: ['sc-drawer-search'],
        });
        this.#searchEntry.connect('search-changed', () => this.#rebuildUI());

        this.#pauseToggleBtn = new Gtk.ToggleButton({
            icon_name: 'action-unavailable-symbolic',
            css_classes: ['flat', 'sc-drawer-icon-btn'],
            tooltip_text: 'Private Mode (pause recording)',
        });
        this.#pauseToggleBtn.connect('toggled', () => {
            if (this.#syncingToggles)
                return;
            this.#client?.setPaused(this.#pauseToggleBtn.get_active()).catch(() => {});
        });

        this.#clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-all-symbolic',
            css_classes: ['flat', 'sc-drawer-icon-btn'],
            tooltip_text: 'Clear unpinned items',
        });
        this.#clearBtn.connect('clicked', () => this.#clearUnpinned());

        const prefsBtn = new Gtk.Button({
            icon_name: 'preferences-system-symbolic',
            css_classes: ['flat', 'sc-drawer-icon-btn'],
            tooltip_text: 'Preferences',
        });
        prefsBtn.connect('clicked', () => {
            this.#hideWindow();
            this.#client?.openPreferences().catch(() => {});
        });

        controls.append(this.#searchEntry);
        controls.append(this.#pauseToggleBtn);
        controls.append(this.#clearBtn);
        controls.append(prefsBtn);
        this.#drawerBox.append(controls);

        const scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            height_request: 230,
            vexpand: true,
        });

        this.#drawerList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            activate_on_single_click: true,
            css_classes: ['sc-drawer-list'],
        });
        this.#drawerList.connect('row-activated', (_lb, row) => {
            if (row?._scEntry)
                this.#activateEntry(row._scEntry);
        });
        scroller.set_child(this.#drawerList);
        this.#drawerBox.append(scroller);

        return this.#drawerBox;
    }

    #setExpanded(expanded) {
        const next = Boolean(expanded);
        if (this.#expanded === next)
            return;
        this.#expanded = next;
        this.#drawerBox.set_visible(this.#expanded);
        this.#expandBtn.set_icon_name(this.#expanded ? 'go-down-symbolic' : 'go-next-symbolic');
        this.#expandBtn.set_tooltip_text(this.#expanded ? 'Collapse to 3-preview bar' : 'Expand full history & search');
        if (this.#expanded) {
            this.#rebuildDrawerList();
            this.#searchEntry.grab_focus();
        }
    }

    async #refreshFromExtension() {
        try {
            const state = await this.#client.getState();
            this.#entries = Array.isArray(state.entries) ? state.entries : [];
            this.#paused = Boolean(state.paused);
            this.#hasLoadedOnce = true;
            if (state.shortcut)
                this.#shortcutLabel.set_label(formatShortcutBadge(state.shortcut));

            this.#syncingToggles = true;
            this.#pauseToggleBtn.set_active(this.#paused);
            this.#syncingToggles = false;

            this.#pausedBanner.set_visible(this.#paused);
            this.#clearBtn.set_sensitive(this.#entries.some(e => !e.pinned));
            this.#rebuildUI();
        } catch (e) {
            console.warn(`[smart-clipboard-popup] State sync failed: ${e.message}`);
        }
    }

    #rebuildUI() {
        const query = this.#expanded ? this.#searchEntry.get_text() : '';
        const cat = this.#textOnly ? 'text' : 'all';
        this.#visibleEntries = filterEntries(this.#entries, query, cat);

        if (this.#selectedStripIdx >= Math.min(STRIP_COUNT, this.#visibleEntries.length))
            this.#selectedStripIdx = 0;

        this.#rebuildStrip();
        if (this.#expanded)
            this.#rebuildDrawerList();
    }

    #rebuildStrip() {
        let child = this.#stripTilesBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.#stripTilesBox.remove(child);
            child = next;
        }
        this.#tileWidgets = [];

        for (let i = 0; i < STRIP_COUNT; i++) {
            const entry = this.#visibleEntries[i] ?? null;
            const tile = entry ? this.#createPreviewTile(entry, i) : this.#createEmptyTile(i);
            this.#tileWidgets.push(tile);
            this.#stripTilesBox.append(tile);
        }
    }

    #createEmptyTile(index) {
        const label = new Gtk.Label({
            label: index === 0 ? 'Copy anything to start' : 'Empty slot',
            hexpand: true,
            vexpand: true,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['sc-tile-empty-label'],
        });
        return clampBox(label, TILE_W, TILE_H, ['sc-tile-empty']);
    }

    #createPreviewTile(entry, index) {
        const overlay = new Gtk.Overlay({
            overflow: Gtk.Overflow.HIDDEN,
            css_classes: index === this.#selectedStripIdx
                ? ['sc-tile', 'sc-tile-selected']
                : ['sc-tile'],
        });
        overlay._scEntry = entry;

        let inner;
        const resolvedImg = resolveEntryImage(entry);
        if (resolvedImg) {
            const pic = new Gtk.Picture({
                content_fit: Gtk.ContentFit.COVER,
                can_shrink: true,
                hexpand: true,
                vexpand: true,
            });
            const tex = this.#getScaledTexture(resolvedImg.thumbPath || resolvedImg.path);
            if (tex)
                pic.set_paintable(tex);
            else
                pic.set_file(resolvedImg.file);
            inner = pic;
        } else if (entry.subtype === 'color') {
            const parsed = parseCssColor(entry.colorValue || entry.text);
            const colorBox = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                hexpand: true,
                vexpand: true,
                css_classes: ['sc-tile-color-bg'],
            });
            if (parsed && /^[#a-zA-Z0-9(),.%\s/+-]+$/.test(parsed.css)) {
                const prov = new Gtk.CssProvider();
                prov.load_from_string(`.sc-tile-color-bg { background-color: ${parsed.css}; }`);
                colorBox.get_style_context().add_provider(prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
            }
            colorBox.append(new Gtk.Label({
                label: entry.text.trim(),
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
                hexpand: true,
                vexpand: true,
                css_classes: ['sc-tile-color-pill', 'monospace'],
            }));
            inner = colorBox;
        } else {
            const textBox = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                hexpand: true,
                vexpand: true,
                css_classes: ['sc-tile-text-box'],
            });
            if (entry.sourceApp) {
                textBox.append(new Gtk.Label({
                    label: entry.sourceApp,
                    xalign: 0,
                    ellipsize: Pango.EllipsizeMode.END,
                    css_classes: ['sc-tile-code-header', 'monospace'],
                }));
            }
            textBox.append(new Gtk.Label({
                label: formatTextPreview(entry.text, entry.sourceApp ? 4 : 5, 160),
                xalign: 0,
                yalign: 0,
                lines: entry.sourceApp ? 4 : 5,
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                ellipsize: Pango.EllipsizeMode.END,
                hexpand: true,
                vexpand: true,
                css_classes: entry.subtype === 'code'
                    ? ['sc-tile-text', 'monospace']
                    : ['sc-tile-text'],
            }));
            inner = textBox;
        }

        // Hard-lock every tile to exact TILE_W x TILE_H regardless of source image/text size
        overlay.set_child(clampBox(inner, TILE_W, TILE_H));

        if (entry.pinned) {
            overlay.add_overlay(new Gtk.Image({
                icon_name: 'view-pin-symbolic',
                pixel_size: 11,
                halign: Gtk.Align.START,
                valign: Gtk.Align.START,
                css_classes: ['sc-tile-pin-dot'],
            }));
        }

        const hoverActions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            halign: Gtk.Align.END,
            valign: Gtk.Align.END,
            css_classes: ['sc-tile-actions'],
            visible: false,
        });

        const addMiniBtn = (icon, tooltip, extraClass, onClick) => {
            const btn = new Gtk.Button({
                icon_name: icon,
                css_classes: extraClass ? ['flat', 'sc-tile-action-btn', extraClass] : ['flat', 'sc-tile-action-btn'],
                tooltip_text: tooltip,
            });
            btn.connect('clicked', onClick);
            hoverActions.append(btn);
        };

        addMiniBtn('edit-copy-symbolic', 'Copy', null, () => this.#copyEntryOnly(entry));
        addMiniBtn('view-pin-symbolic', entry.pinned ? 'Unpin' : 'Pin', entry.pinned ? 'sc-pin-active' : null,
            () => this.#togglePin(entry.id));
        addMiniBtn('view-reveal-symbolic', 'Full preview', null, () => this.#openPreviewDialog(entry));
        addMiniBtn('user-trash-symbolic', 'Delete', 'sc-danger-btn', () => this.#deleteEntry(entry.id));

        overlay.add_overlay(hoverActions);

        const motion = new Gtk.EventControllerMotion();
        motion.connect('enter', () => {
            hoverActions.set_visible(true);
            this.#selectStripIndex(index);
        });
        motion.connect('leave', () => {
            hoverActions.set_visible(false);
        });
        overlay.add_controller(motion);

        const click = new Gtk.GestureClick({button: Gdk.BUTTON_PRIMARY});
        click.connect('released', (_g, _nPress, x, y) => {
            const picked = overlay.pick(x, y, Gtk.PickFlags.DEFAULT);
            if (picked && (picked === hoverActions || picked.is_ancestor(hoverActions)))
                return;
            this.#activateEntry(entry);
        });
        overlay.add_controller(click);

        this.#attachDragAndDrop(overlay, entry, 'sc-tile-drop-target');
        return overlay;
    }

    #selectStripIndex(index) {
        if (index < 0 || index >= Math.min(STRIP_COUNT, this.#visibleEntries.length))
            return;
        this.#selectedStripIdx = index;
        this.#tileWidgets.forEach((w, i) => {
            if (!w._scEntry)
                return;
            if (i === this.#selectedStripIdx)
                w.add_css_class('sc-tile-selected');
            else
                w.remove_css_class('sc-tile-selected');
        });
    }

    #rebuildDrawerList() {
        let child = this.#drawerList.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.#drawerList.remove(child);
            child = next;
        }

        const query = this.#searchEntry.get_text().trim();
        const items = query ? this.#visibleEntries : this.#visibleEntries.slice(STRIP_COUNT);

        for (const entry of items)
            this.#drawerList.append(this.#createDrawerRow(entry));
    }

    #createDrawerRow(entry) {
        const row = new Gtk.ListBoxRow({
            css_classes: entry.pinned ? ['sc-drawer-row-pinned'] : [],
        });
        row._scEntry = entry;

        const hbox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
        });

        const resolvedImg = resolveEntryImage(entry);
        if (resolvedImg) {
            const pic = new Gtk.Picture({
                content_fit: Gtk.ContentFit.COVER,
                can_shrink: true,
                hexpand: true,
                vexpand: true,
            });
            const tex = this.#getScaledTexture(resolvedImg.thumbPath || resolvedImg.path);
            if (tex)
                pic.set_paintable(tex);
            else
                pic.set_file(resolvedImg.file);
            hbox.append(clampBox(pic, THUMB_W, THUMB_H, ['sc-drawer-thumb']));
        } else if (entry.subtype === 'color') {
            const parsed = parseCssColor(entry.colorValue || entry.text);
            const dot = new Gtk.Box({valign: Gtk.Align.CENTER, css_classes: ['sc-color-dot']});
            if (parsed && /^[#a-zA-Z0-9(),.%\s/+-]+$/.test(parsed.css)) {
                const prov = new Gtk.CssProvider();
                prov.load_from_string(`.sc-color-dot { background-color: ${parsed.css}; }`);
                dot.get_style_context().add_provider(prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
            }
            hbox.append(dot);
        }

        const col = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        col.append(new Gtk.Label({
            label: resolvedImg
                ? (entry.type === 'image'
                    ? `Image${entry.width && entry.height ? ` ${entry.width}×${entry.height}` : ''}`
                    : resolvedImg.file.get_basename())
                : formatTextPreview(entry.text, 1, 80, ' '),
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
        }));
        const meta = [];
        meta.push(entry.type === 'image' ? formatBytes(entry.sizeBytes) : `${entry.charCount} chars`);
        if (entry.sourceApp)
            meta.push(entry.sourceApp);
        const rel = formatRelativeTime(entry.updatedAt);
        if (rel)
            meta.push(rel);
        col.append(new Gtk.Label({
            label: meta.join(' · '),
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            css_classes: ['sc-drawer-meta'],
        }));
        hbox.append(col);

        const actions = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 2, valign: Gtk.Align.CENTER});
        const addBtn = (icon, tip, cls, cb) => {
            const b = new Gtk.Button({
                icon_name: icon,
                css_classes: cls ? ['flat', 'sc-tile-action-btn', cls] : ['flat', 'sc-tile-action-btn'],
                tooltip_text: tip,
            });
            b.connect('clicked', cb);
            actions.append(b);
        };
        addBtn('edit-copy-symbolic', 'Copy', null, () => this.#copyEntryOnly(entry));
        addBtn('view-pin-symbolic', entry.pinned ? 'Unpin' : 'Pin', entry.pinned ? 'sc-pin-active' : null,
            () => this.#togglePin(entry.id));
        addBtn('view-reveal-symbolic', 'Preview', null, () => this.#openPreviewDialog(entry));
        addBtn('user-trash-symbolic', 'Delete', 'sc-danger-btn', () => this.#deleteEntry(entry.id));
        hbox.append(actions);

        row.set_child(hbox);
        this.#attachDragAndDrop(row, entry, 'sc-tile-drop-target');
        return row;
    }

    #attachDragAndDrop(widget, entry, dropCssClass) {
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
            const resolvedImg = resolveEntryImage(entry);
            if (resolvedImg) {
                const tex = this.#getScaledTexture(resolvedImg.thumbPath || resolvedImg.path);
                if (tex) {
                    src.set_icon(tex, 12, 12);
                    return;
                }
            }
            const icon = Gtk.DragIcon.get_for_drag(drag);
            if (icon) {
                icon.set_child(new Gtk.Label({
                    label: resolvedImg ? 'Image' : formatTextPreview(entry.text, 1, 36, ' '),
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
        widget.add_controller(dragSource);

        if (entry.pinned) {
            const dropTarget = Gtk.DropTargetAsync.new(
                Gdk.ContentFormats.new([PIN_DRAG_MIME]),
                Gdk.DragAction.MOVE
            );
            dropTarget.connect('drag-enter', () => {
                widget.add_css_class(dropCssClass);
                return Gdk.DragAction.MOVE;
            });
            dropTarget.connect('drag-motion', () => Gdk.DragAction.MOVE);
            dropTarget.connect('drag-leave', () => widget.remove_css_class(dropCssClass));
            dropTarget.connect('drop', (_t, drop) => {
                widget.remove_css_class(dropCssClass);
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
            widget.add_controller(dropTarget);
        }
    }

    #openPreviewDialog(entry) {
        this.#inModal = true;
        this.#cancelFocusAutoHide();

        const resolvedImg = resolveEntryImage(entry);
        const dialog = new Adw.Dialog({
            title: resolvedImg
                ? (entry.type === 'image' && entry.width && entry.height
                    ? `Image (${entry.width}×${entry.height})`
                    : resolvedImg.file.get_basename())
                : 'Preview',
            content_width: 560,
            content_height: 420,
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

        if (resolvedImg) {
            const pic = new Gtk.Picture({
                content_fit: Gtk.ContentFit.CONTAIN,
                can_shrink: true,
                hexpand: true,
                vexpand: true,
            });
            pic.set_file(resolvedImg.file);
            body.append(clampBox(pic, 520, 320, ['sc-dialog-image']));
        } else {
            const scroller = new Gtk.ScrolledWindow({hexpand: true, vexpand: true, css_classes: ['sc-dialog-text']});
            const buffer = new Gtk.TextBuffer();
            buffer.set_text(entry.text, -1);
            scroller.set_child(new Gtk.TextView({
                buffer,
                editable: false,
                wrap_mode: Gtk.WrapMode.WORD_CHAR,
                top_margin: 10,
                bottom_margin: 10,
                left_margin: 12,
                right_margin: 12,
                css_classes: entry.subtype === 'code' ? ['monospace'] : [],
            }));
            body.append(scroller);
        }

        const btnBar = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, halign: Gtk.Align.END});
        if (entry.type === 'text' && (entry.isUrl || entry.subtype === 'url')) {
            const openBtn = new Gtk.Button({label: 'Open Link'});
            openBtn.connect('clicked', () => {
                Gio.AppInfo.launch_default_for_uri_async(entry.text.trim(), null, null, null);
                dialog.close();
            });
            btnBar.append(openBtn);
        }
        const pinBtn = new Gtk.Button({label: entry.pinned ? 'Unpin' : 'Pin', icon_name: 'view-pin-symbolic'});
        pinBtn.connect('clicked', () => {
            this.#togglePin(entry.id);
            dialog.close();
        });
        const copyBtn = new Gtk.Button({
            label: 'Copy & Paste',
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

    #onKeyPressed(keyval, state) {
        if (this.#inModal)
            return false;

        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const focus = this.#window.get_focus();
        const inSearch = focus === this.#searchEntry || focus?.get_parent?.() === this.#searchEntry;

        if (keyval === Gdk.KEY_Escape) {
            if (this.#expanded && this.#searchEntry.get_text().length > 0) {
                this.#searchEntry.set_text('');
                return true;
            }
            if (this.#expanded) {
                this.#setExpanded(false);
                return true;
            }
            this.#hideWindow();
            return true;
        }

        if (!inSearch) {
            if (keyval === Gdk.KEY_Right) {
                this.#selectStripIndex(this.#selectedStripIdx + 1);
                return true;
            }
            if (keyval === Gdk.KEY_Left) {
                this.#selectStripIndex(this.#selectedStripIdx - 1);
                return true;
            }
            if (keyval === Gdk.KEY_Down && !this.#expanded) {
                this.#setExpanded(true);
                return true;
            }
            if (keyval >= Gdk.KEY_1 && keyval <= Gdk.KEY_3 && !ctrl) {
                const entry = this.#visibleEntries[keyval - Gdk.KEY_1];
                if (entry) {
                    this.#activateEntry(entry);
                    return true;
                }
            }
            if (keyval === Gdk.KEY_space) {
                const entry = this.#visibleEntries[this.#selectedStripIdx];
                if (entry) {
                    this.#openPreviewDialog(entry);
                    return true;
                }
            }
        }

        const activeEntry = this.#visibleEntries[this.#selectedStripIdx] ?? null;
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            if (this.#expanded && this.#drawerList.get_selected_row()?._scEntry) {
                this.#activateEntry(this.#drawerList.get_selected_row()._scEntry);
                return true;
            }
            if (activeEntry) {
                this.#activateEntry(activeEntry);
                return true;
            }
        }

        if (ctrl && keyval === Gdk.KEY_p && activeEntry) {
            this.#togglePin(activeEntry.id);
            return true;
        }
        if (ctrl && keyval === Gdk.KEY_z && !inSearch) {
            this.#undoDelete();
            return true;
        }
        if ((keyval === Gdk.KEY_Delete || keyval === Gdk.KEY_KP_Delete) && !inSearch && activeEntry) {
            this.#deleteEntry(activeEntry.id);
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
                this.#showUndoToast(`Cleared ${count}`);
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
        const toast = new Adw.Toast({title: message, button_label: 'Undo', timeout: 5});
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

        // Reset selection highlight without rebuilding tiles — open is 0ms on the hot path
        if (this.#selectedStripIdx !== 0)
            this.#selectStripIndex(0);
        if (this.#expanded)
            this.#setExpanded(false);
        if (this.#searchEntry.get_text().length > 0)
            this.#searchEntry.set_text('');

        // Present immediately using already-warm tiles
        this.#window.present();

        // Only fetch over D-Bus if startup fetch hasn't completed yet (live changes arrive via Changed signal)
        if (!this.#hasLoadedOnce)
            this.#refreshFromExtension();
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
        this.#thumbCache.clear();
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
