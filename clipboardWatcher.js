import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;
const SELECTION_TYPE = Meta.SelectionType.SELECTION_CLIPBOARD;
const DEBOUNCE_MS = 50;
const SELF_COPY_SUPPRESS_US = 1_500_000;

const TEXT_MIMETYPES = [
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'text/plain',
    'STRING',
];

const IMAGE_MIMETYPES = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
    'image/bmp',
];

const ALWAYS_SENSITIVE_PREFIXES = [
    'application/x-keepassxc-',
    'application/x-gnome-password',
    'application/x-bitwarden-',
];

export class ClipboardWatcher {
    #selection = null;
    #clipboard = null;
    #ownerChangedId = 0;
    #debounceId = 0;
    #captureSeq = 0;
    #paused = false;
    #captureImages = true;
    #maxImageSizeMb = 10;
    #suppressHash = null;
    #suppressUntilUs = 0;
    #onText = null;
    #onImage = null;
    #destroyed = false;
    #decoder = new TextDecoder('utf-8');

    constructor({paused = false, captureImages = true, maxImageSizeMb = 10, onText, onImage}) {
        this.#paused = paused;
        this.#captureImages = captureImages;
        this.#maxImageSizeMb = maxImageSizeMb;
        this.#onText = onText;
        this.#onImage = onImage;

        this.#clipboard = St.Clipboard.get_default();
        this.#selection = global.display.get_selection();
        this.#ownerChangedId = this.#selection.connect(
            'owner-changed',
            (_selection, selectionType, _selectionSource) => {
                if (this.#destroyed || this.#paused)
                    return;
                if (selectionType !== SELECTION_TYPE)
                    return;
                this.#scheduleCapture();
            }
        );
    }

    setConfig({paused, captureImages, maxImageSizeMb}) {
        if (typeof paused === 'boolean')
            this.#paused = paused;
        if (typeof captureImages === 'boolean')
            this.#captureImages = captureImages;
        if (typeof maxImageSizeMb === 'number')
            this.#maxImageSizeMb = maxImageSizeMb;
    }

    copyPlainText(text) {
        if (this.#destroyed || typeof text !== 'string' || !this.#clipboard)
            return false;

        this.#cancelDebounce();
        this.#suppressHash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
        this.#suppressUntilUs = GLib.get_monotonic_time() + SELF_COPY_SUPPRESS_US;
        this.#clipboard.set_text(CLIPBOARD_TYPE, text);
        return true;
    }

    async copyEntryToClipboard(entry, store) {
        if (this.#destroyed || !entry || !this.#clipboard)
            return false;

        this.#cancelDebounce();
        this.#suppressHash = entry.hash;
        this.#suppressUntilUs = GLib.get_monotonic_time() + SELF_COPY_SUPPRESS_US;

        if (entry.type === 'text') {
            this.#clipboard.set_text(CLIPBOARD_TYPE, entry.text);
            return true;
        }

        if (entry.type === 'image') {
            try {
                const bytes = await store.readImageBytes(entry);
                if (this.#destroyed || !bytes || bytes.get_size() === 0)
                    return false;
                this.#suppressHash = entry.hash;
                this.#suppressUntilUs = GLib.get_monotonic_time() + SELF_COPY_SUPPRESS_US;
                this.#clipboard.set_content(CLIPBOARD_TYPE, entry.mimeType || 'image/png', bytes);
                return true;
            } catch (e) {
                console.warn(`[smart-clipboard] Failed to restore image to clipboard: ${e.message}`);
                return false;
            }
        }

        return false;
    }

    #scheduleCapture() {
        this.#cancelDebounce();
        const seq = ++this.#captureSeq;
        this.#debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this.#debounceId = 0;
            this.#capture(seq).catch(e => {
                if (!this.#destroyed)
                    console.warn(`[smart-clipboard] Capture error: ${e.message}`);
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    #cancelDebounce() {
        if (this.#debounceId !== 0) {
            GLib.Source.remove(this.#debounceId);
            this.#debounceId = 0;
        }
    }

    #isSuppressed(hash) {
        if (!this.#suppressHash)
            return false;
        if (GLib.get_monotonic_time() > this.#suppressUntilUs) {
            this.#suppressHash = null;
            return false;
        }
        if (hash === this.#suppressHash) {
            this.#suppressHash = null;
            return true;
        }
        return false;
    }

    async #capture(seq) {
        if (this.#destroyed || this.#paused || seq !== this.#captureSeq)
            return;

        const mimetypes = this.#selection?.get_mimetypes(SELECTION_TYPE) ?? [];
        if (mimetypes.length === 0)
            return;

        if (await this.#isSensitive(mimetypes))
            return;
        if (this.#destroyed || this.#paused || seq !== this.#captureSeq)
            return;

        const hasTextMime = TEXT_MIMETYPES.some(m => mimetypes.includes(m));
        const imageMime = IMAGE_MIMETYPES.find(m => mimetypes.includes(m)) ?? null;

        if (hasTextMime) {
            const text = await this.#getTextAsync();
            if (this.#destroyed || this.#paused || seq !== this.#captureSeq)
                return;

            if (text && text.trim().length > 0) {
                const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
                if (!this.#isSuppressed(hash))
                    await this.#onText?.(text);
                return;
            }
            // If text was empty/whitespace and an image mimetype is also offered, fall through to image
        }

        if (this.#captureImages && imageMime) {
            const bytes = await this.#getContentAsync(imageMime);
            if (this.#destroyed || this.#paused || seq !== this.#captureSeq)
                return;
            if (!bytes)
                return;

            const sizeBytes = bytes.get_size();
            const maxBytes = this.#maxImageSizeMb * 1024 * 1024;
            if (sizeBytes <= 0 || sizeBytes > maxBytes)
                return;

            const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
            if (!this.#isSuppressed(hash))
                await this.#onImage?.(bytes, imageMime);
        }
    }

    async #isSensitive(mimetypes) {
        let kdeHintMime = null;
        for (const mime of mimetypes) {
            const lower = mime.toLowerCase();
            if (lower === 'x-kde-passwordmanagerhint') {
                kdeHintMime = mime;
                continue;
            }
            if (ALWAYS_SENSITIVE_PREFIXES.some(prefix => lower.startsWith(prefix)))
                return true;
        }

        if (!kdeHintMime)
            return false;

        // Treat x-kde-passwordManagerHint as sensitive unless explicitly marked "public"
        const hintBytes = await this.#getContentAsync(kdeHintMime);
        if (!hintBytes || hintBytes.get_size() === 0)
            return true;

        try {
            const hintValue = this.#decoder.decode(hintBytes.get_data()).trim().toLowerCase();
            return hintValue !== 'public';
        } catch {
            return true;
        }
    }

    #getTextAsync() {
        return new Promise(resolve => {
            if (this.#destroyed || !this.#clipboard) {
                resolve(null);
                return;
            }
            this.#clipboard.get_text(CLIPBOARD_TYPE, (_clipboard, text) => {
                resolve(text ?? null);
            });
        });
    }

    #getContentAsync(mimeType) {
        return new Promise(resolve => {
            if (this.#destroyed || !this.#clipboard) {
                resolve(null);
                return;
            }
            this.#clipboard.get_content(CLIPBOARD_TYPE, mimeType, (_clipboard, bytes) => {
                resolve(bytes ?? null);
            });
        });
    }

    destroy() {
        this.#destroyed = true;
        this.#captureSeq++;
        this.#cancelDebounce();
        if (this.#selection && this.#ownerChangedId !== 0) {
            this.#selection.disconnect(this.#ownerChangedId);
            this.#ownerChangedId = 0;
        }
        this.#selection = null;
        this.#clipboard = null;
        this.#onText = null;
        this.#onImage = null;
    }
}
