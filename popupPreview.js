import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {
    buildDragContentProvider,
    formatBytes,
    formatRelativeTime,
    parseCssColor,
    transformText,
} from './popupClient.js';

const TYPE_LABELS = {
    image: 'IMAGE',
    color: 'COLOR',
    url: 'LINK',
    email: 'EMAIL',
    code: 'CODE',
    text: 'TEXT',
};

export class PreviewPane {
    #root;
    #stack;
    #entry = null;
    #autoPaste = true;
    #editing = false;
    #callbacks;
    #swatchProvider = null;

    #badgeLabel;
    #metaLabel;
    #contentStack;

    #imagePicture;
    #imageStage;
    #saveImgBtn;
    #openImgBtn;

    #colorBox;
    #colorHexLabel;
    #colorRgbLabel;

    #textView;
    #textBuffer;
    #transformBox;
    #openUrlBtn;
    #formatJsonBtn;

    #pasteBtn;
    #copyBtn;
    #pinBtn;
    #editBtn;
    #saveEditBtn;
    #cancelEditBtn;
    #deleteBtn;

    constructor(callbacks) {
        this.#callbacks = callbacks;

        this.#root = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['sc-preview-pane'],
            hexpand: true,
            vexpand: true,
        });

        this.#stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 90,
            hexpand: true,
            vexpand: true,
        });

        // Empty state
        const emptyBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            spacing: 8,
            css_classes: ['sc-preview-empty'],
        });
        emptyBox.append(new Gtk.Image({
            icon_name: 'edit-paste-symbolic',
            pixel_size: 42,
            css_classes: ['dim-label'],
        }));
        emptyBox.append(new Gtk.Label({
            label: 'Select an item to preview',
            css_classes: ['dim-label'],
        }));
        emptyBox.append(new Gtk.Label({
            label: 'Drag any row or preview into another app',
            css_classes: ['caption', 'dim-label'],
        }));
        this.#stack.add_named(emptyBox, 'empty');

        // Active preview container
        const mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 14,
            margin_end: 14,
            hexpand: true,
            vexpand: true,
        });

        // Header metadata row
        const headerRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
        });
        this.#badgeLabel = new Gtk.Label({
            css_classes: ['sc-type-badge'],
            valign: Gtk.Align.CENTER,
        });
        this.#metaLabel = new Gtk.Label({
            xalign: 0,
            ellipsize: 3, // Pango.EllipsizeMode.END
            hexpand: true,
            css_classes: ['caption', 'dim-label'],
            valign: Gtk.Align.CENTER,
        });
        headerRow.append(this.#badgeLabel);
        headerRow.append(this.#metaLabel);
        mainBox.append(headerRow);

        // Content stack (image / text / color)
        this.#contentStack = new Gtk.Stack({
            hexpand: true,
            vexpand: true,
        });
        this.#buildImageView();
        this.#buildTextView();
        this.#buildColorView();
        mainBox.append(this.#contentStack);

        // Quick transforms bar (for text)
        this.#buildTransformBar();
        mainBox.append(this.#transformBox);

        // Primary action bar
        mainBox.append(this.#buildActionBar());

        this.#stack.add_named(mainBox, 'detail');
        this.#stack.set_visible_child_name('empty');
        this.#root.append(this.#stack);
    }

    get widget() {
        return this.#root;
    }

    get isEditing() {
        return this.#editing;
    }

    get currentEntry() {
        return this.#entry;
    }

    #buildImageView() {
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
            vexpand: true,
        });

        this.#imageStage = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['sc-image-stage'],
            hexpand: true,
            vexpand: true,
            overflow: Gtk.Overflow.HIDDEN,
        });

        this.#imagePicture = new Gtk.Picture({
            content_fit: Gtk.ContentFit.CONTAIN,
            can_shrink: true,
            hexpand: true,
            vexpand: true,
        });
        this.#imageStage.append(this.#imagePicture);
        this.#attachPreviewDragSource(this.#imageStage);

        const imgTools = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
        });

        const dragHint = new Gtk.Label({
            label: 'Drag image straight into any app',
            xalign: 0,
            hexpand: true,
            css_classes: ['caption', 'dim-label'],
        });

        this.#saveImgBtn = new Gtk.Button({
            label: 'Save As…',
            icon_name: 'document-save-as-symbolic',
            css_classes: ['flat', 'sc-pill-btn'],
        });
        this.#saveImgBtn.connect('clicked', () => this.#saveCurrentImage());

        this.#openImgBtn = new Gtk.Button({
            label: 'Open',
            icon_name: 'external-link-symbolic',
            css_classes: ['flat', 'sc-pill-btn'],
        });
        this.#openImgBtn.connect('clicked', () => this.#openCurrentImage());

        imgTools.append(dragHint);
        imgTools.append(this.#saveImgBtn);
        imgTools.append(this.#openImgBtn);

        container.append(this.#imageStage);
        container.append(imgTools);
        this.#contentStack.add_named(container, 'image');
    }

    #buildColorView() {
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            hexpand: true,
            vexpand: true,
        });

        this.#colorBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.FILL,
            hexpand: true,
            vexpand: true,
            css_classes: ['sc-color-stage'],
        });
        this.#attachPreviewDragSource(this.#colorBox);

        this.#colorHexLabel = new Gtk.Label({
            selectable: true,
            css_classes: ['title-2', 'monospace'],
            xalign: 0,
        });
        this.#colorRgbLabel = new Gtk.Label({
            selectable: true,
            css_classes: ['caption', 'dim-label', 'monospace'],
            xalign: 0,
        });

        container.append(this.#colorBox);
        container.append(this.#colorHexLabel);
        container.append(this.#colorRgbLabel);
        this.#contentStack.add_named(container, 'color');
    }

    #buildTextView() {
        const scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            css_classes: ['sc-text-stage'],
        });

        this.#textBuffer = new Gtk.TextBuffer();
        this.#textView = new Gtk.TextView({
            buffer: this.#textBuffer,
            editable: false,
            cursor_visible: false,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 10,
            bottom_margin: 10,
            left_margin: 12,
            right_margin: 12,
            css_classes: ['sc-preview-textview'],
        });
        scroller.set_child(this.#textView);
        this.#contentStack.add_named(scroller, 'text');
    }

    #buildTransformBar() {
        this.#transformBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 5,
            hexpand: true,
            visible: false,
        });

        const addPill = (label, tooltip, onClick) => {
            const btn = new Gtk.Button({
                label,
                tooltip_text: tooltip,
                css_classes: ['flat', 'sc-transform-pill'],
            });
            btn.connect('clicked', onClick);
            this.#transformBox.append(btn);
            return btn;
        };

        this.#openUrlBtn = addPill('Open Link', 'Open URL in default browser', () => {
            if (!this.#entry?.text)
                return;
            Gio.AppInfo.launch_default_for_uri_async(this.#entry.text.trim(), null, null, null);
        });
        this.#formatJsonBtn = addPill('Format JSON', 'Pretty-print JSON and copy', () =>
            this.#applyTransform('format-json', 'Formatted JSON copied'));

        addPill('1-Line', 'Collapse whitespace into a single line and copy', () =>
            this.#applyTransform('single-line', 'Single-line text copied'));
        addPill('Trim', 'Copy trimmed text', () =>
            this.#applyTransform('trim', 'Trimmed text copied'));
        addPill('UPPER', 'Copy in UPPERCASE', () =>
            this.#applyTransform('upper', 'UPPERCASE text copied'));
        addPill('lower', 'Copy in lowercase', () =>
            this.#applyTransform('lower', 'lowercase text copied'));
    }

    #buildActionBar() {
        const bar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
            css_classes: ['sc-preview-actions'],
        });

        this.#pasteBtn = new Gtk.Button({
            label: 'Paste',
            icon_name: 'edit-paste-symbolic',
            css_classes: ['suggested-action'],
            tooltip_text: 'Paste into previous app (Enter)',
        });
        this.#pasteBtn.connect('clicked', () => {
            if (this.#entry)
                this.#callbacks.onPaste?.(this.#entry);
        });

        this.#copyBtn = new Gtk.Button({
            label: 'Copy',
            icon_name: 'edit-copy-symbolic',
            tooltip_text: 'Copy to clipboard without closing (Ctrl+C)',
        });
        this.#copyBtn.connect('clicked', () => {
            if (this.#entry)
                this.#callbacks.onCopy?.(this.#entry);
        });

        this.#pinBtn = new Gtk.Button({
            icon_name: 'view-pin-symbolic',
            tooltip_text: 'Pin / Unpin (Ctrl+P)',
        });
        this.#pinBtn.connect('clicked', () => {
            if (this.#entry)
                this.#callbacks.onTogglePin?.(this.#entry);
        });

        this.#editBtn = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            tooltip_text: 'Edit snippet inline (Ctrl+E)',
        });
        this.#editBtn.connect('clicked', () => this.startEdit());

        this.#saveEditBtn = new Gtk.Button({
            label: 'Save',
            css_classes: ['suggested-action'],
            visible: false,
        });
        this.#saveEditBtn.connect('clicked', () => this.commitEdit());

        this.#cancelEditBtn = new Gtk.Button({
            label: 'Cancel',
            visible: false,
        });
        this.#cancelEditBtn.connect('clicked', () => this.cancelEdit());

        const spacer = new Gtk.Box({hexpand: true});

        this.#deleteBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            css_classes: ['flat', 'sc-danger-btn'],
            tooltip_text: 'Delete item (Delete)',
        });
        this.#deleteBtn.connect('clicked', () => {
            if (this.#entry)
                this.#callbacks.onDelete?.(this.#entry);
        });

        bar.append(this.#pasteBtn);
        bar.append(this.#copyBtn);
        bar.append(this.#pinBtn);
        bar.append(this.#editBtn);
        bar.append(this.#saveEditBtn);
        bar.append(this.#cancelEditBtn);
        bar.append(spacer);
        bar.append(this.#deleteBtn);
        return bar;
    }

    #attachPreviewDragSource(widget) {
        const dragSource = new Gtk.DragSource({
            actions: Gdk.DragAction.COPY,
        });
        dragSource.connect('prepare', () => {
            if (!this.#entry)
                return null;
            return buildDragContentProvider(this.#entry, Gdk, {includePinOrder: false});
        });
        dragSource.connect('drag-begin', (src) => {
            this.#callbacks.onDragStateChanged?.(true);
            if (this.#entry?.type === 'image') {
                const path = this.#entry.thumbPath || this.#entry.imagePath;
                if (path) {
                    try {
                        src.set_icon(Gdk.Texture.new_from_filename(path), 16, 16);
                    } catch {
                        // fallback to default drag icon
                    }
                }
            }
        });
        dragSource.connect('drag-end', () => this.#callbacks.onDragStateChanged?.(false));
        dragSource.connect('drag-cancel', () => {
            this.#callbacks.onDragStateChanged?.(false);
            return false;
        });
        widget.add_controller(dragSource);
    }

    #applyTransform(mode, toastMsg) {
        if (!this.#entry || this.#entry.type !== 'text')
            return;
        try {
            const out = transformText(this.#entry.text, mode);
            this.#callbacks.onCopyTransformed?.(out, toastMsg);
        } catch (e) {
            this.#callbacks.onToast?.(`Transform failed: ${e.message}`);
        }
    }

    #saveCurrentImage() {
        if (!this.#entry || this.#entry.type !== 'image' || !this.#entry.imagePath)
            return;
        const srcFile = Gio.File.new_for_path(this.#entry.imagePath);
        if (!srcFile.query_exists(null))
            return;

        const ext = this.#entry.imageFile?.split('.').pop() || 'png';
        const dialog = new Gtk.FileDialog({
            title: 'Save Clipboard Image',
            initial_name: `clipboard-${this.#entry.hash.slice(0, 8)}.${ext}`,
        });
        const parentWin = this.#root.get_root();
        this.#callbacks.onModalStateChanged?.(true);
        dialog.save(parentWin, null, (dlg, res) => {
            this.#callbacks.onModalStateChanged?.(false);
            try {
                const dest = dlg.save_finish(res);
                if (dest) {
                    srcFile.copy_async(
                        dest,
                        Gio.FileCopyFlags.OVERWRITE,
                        GLib.PRIORITY_DEFAULT,
                        null,
                        null,
                        (f, copyRes) => {
                            try {
                                f.copy_finish(copyRes);
                                this.#callbacks.onToast?.(`Saved to ${dest.get_basename()}`);
                            } catch (err) {
                                this.#callbacks.onToast?.(`Save failed: ${err.message}`);
                            }
                        }
                    );
                }
            } catch {
                // user cancelled
            }
        });
    }

    #openCurrentImage() {
        if (!this.#entry?.imagePath)
            return;
        const file = Gio.File.new_for_path(this.#entry.imagePath);
        const launcher = Gtk.FileLauncher.new(file);
        launcher.launch(this.#root.get_root(), null, null);
    }

    setAutoPaste(enabled) {
        this.#autoPaste = Boolean(enabled);
        this.#pasteBtn.set_label(this.#autoPaste ? 'Paste' : 'Copy & Close');
    }

    setEntry(entry) {
        const sameId = this.#entry && entry && this.#entry.id === entry.id;
        if (this.#editing && !sameId)
            this.cancelEdit();

        this.#entry = entry ?? null;
        if (!this.#entry) {
            this.#stack.set_visible_child_name('empty');
            return;
        }

        this.#stack.set_visible_child_name('detail');

        // Header badge & metadata
        const kind = this.#entry.type === 'image'
            ? 'image'
            : (this.#entry.isJson ? 'json' : (this.#entry.subtype || 'text'));
        this.#badgeLabel.set_label(kind === 'json' ? 'JSON' : (TYPE_LABELS[kind] ?? 'TEXT'));

        const parts = [];
        if (this.#entry.type === 'image') {
            if (this.#entry.width && this.#entry.height)
                parts.push(`${this.#entry.width}×${this.#entry.height}`);
            parts.push(formatBytes(this.#entry.sizeBytes));
        } else {
            const words = this.#entry.wordCount ?? 0;
            parts.push(`${this.#entry.charCount} chars`);
            parts.push(`${words} ${words === 1 ? 'word' : 'words'}`);
            if (this.#entry.lineCount > 1)
                parts.push(`${this.#entry.lineCount} lines`);
        }
        if (this.#entry.sourceApp)
            parts.push(`from ${this.#entry.sourceApp}`);
        const rel = formatRelativeTime(this.#entry.updatedAt);
        if (rel)
            parts.push(rel);
        this.#metaLabel.set_label(parts.join(' · '));

        // Pin visual state
        if (this.#entry.pinned) {
            this.#pinBtn.add_css_class('sc-pin-active');
            this.#pinBtn.set_tooltip_text('Unpin item (Ctrl+P)');
        } else {
            this.#pinBtn.remove_css_class('sc-pin-active');
            this.#pinBtn.set_tooltip_text('Pin item (Ctrl+P)');
        }

        if (this.#entry.type === 'image') {
            this.#contentStack.set_visible_child_name('image');
            this.#transformBox.set_visible(false);
            this.#editBtn.set_visible(false);
            if (this.#entry.imagePath) {
                const f = Gio.File.new_for_path(this.#entry.imagePath);
                this.#imagePicture.set_file(f.query_exists(null) ? f : null);
            } else {
                this.#imagePicture.set_file(null);
            }
            return;
        }

        if (this.#entry.subtype === 'color') {
            this.#contentStack.set_visible_child_name('color');
            this.#transformBox.set_visible(false);
            this.#editBtn.set_visible(true);
            const parsed = parseCssColor(this.#entry.colorValue || this.#entry.text);
            const cssColor = parsed?.css ?? this.#entry.text.trim();
            this.#applyColorSwatch(cssColor);
            this.#colorHexLabel.set_label(cssColor);
            if (parsed && parsed.r !== null) {
                const alphaStr = parsed.a < 1 ? `, ${parsed.a.toFixed(2)}` : '';
                this.#colorRgbLabel.set_label(`rgb${alphaStr ? 'a' : ''}(${parsed.r}, ${parsed.g}, ${parsed.b}${alphaStr})`);
            } else {
                this.#colorRgbLabel.set_label('CSS Color');
            }
            return;
        }

        // Standard text / code / JSON / URL / email
        this.#contentStack.set_visible_child_name('text');
        this.#transformBox.set_visible(!this.#editing);
        this.#editBtn.set_visible(!this.#editing);
        this.#openUrlBtn.set_visible(Boolean(this.#entry.isUrl || this.#entry.subtype === 'url'));
        this.#formatJsonBtn.set_visible(Boolean(this.#entry.isJson));

        const isCode = this.#entry.subtype === 'code' || this.#entry.isJson;
        if (isCode)
            this.#textView.add_css_class('monospace');
        else
            this.#textView.remove_css_class('monospace');

        if (!this.#editing)
            this.#textBuffer.set_text(this.#entry.text, -1);
    }

    #applyColorSwatch(cssColor) {
        const display = this.#colorBox.get_display();
        if (!display)
            return;
        if (!this.#swatchProvider) {
            this.#swatchProvider = new Gtk.CssProvider();
            this.#colorBox.get_style_context().add_provider(
                this.#swatchProvider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            );
        }
        // Only pass validated color strings to CSS
        const safe = /^[#a-zA-Z0-9(),.%\s/+-]+$/.test(cssColor) ? cssColor : 'transparent';
        this.#swatchProvider.load_from_string(`.sc-color-stage { background-color: ${safe}; }`);
    }

    startEdit() {
        if (!this.#entry || this.#entry.type !== 'text')
            return;
        this.#editing = true;
        this.#contentStack.set_visible_child_name('text');
        this.#textBuffer.set_text(this.#entry.text, -1);
        this.#textView.set_editable(true);
        this.#textView.set_cursor_visible(true);
        this.#transformBox.set_visible(false);
        this.#pasteBtn.set_visible(false);
        this.#copyBtn.set_visible(false);
        this.#pinBtn.set_visible(false);
        this.#editBtn.set_visible(false);
        this.#deleteBtn.set_visible(false);
        this.#saveEditBtn.set_visible(true);
        this.#cancelEditBtn.set_visible(true);
        this.#textView.grab_focus();
    }

    commitEdit() {
        if (!this.#editing || !this.#entry)
            return;
        const [start, end] = this.#textBuffer.get_bounds();
        const newText = this.#textBuffer.get_text(start, end, true);
        const id = this.#entry.id;
        this.cancelEdit();
        if (newText.trim().length > 0)
            this.#callbacks.onSaveEdit?.(id, newText);
    }

    cancelEdit() {
        if (!this.#editing)
            return;
        this.#editing = false;
        this.#textView.set_editable(false);
        this.#textView.set_cursor_visible(false);
        this.#pasteBtn.set_visible(true);
        this.#copyBtn.set_visible(true);
        this.#pinBtn.set_visible(true);
        this.#editBtn.set_visible(true);
        this.#deleteBtn.set_visible(true);
        this.#saveEditBtn.set_visible(false);
        this.#cancelEditBtn.set_visible(false);
        if (this.#entry)
            this.setEntry(this.#entry);
    }
}
