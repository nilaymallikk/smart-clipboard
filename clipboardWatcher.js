import Gio from 'gi://Gio';
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

const URI_LIST_MIMETYPES = [
    'text/uri-list',
    'x-special/gnome-copied-files',
];

const IMAGE_MIMETYPES = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
    'image/bmp',
];

const EXT_TO_IMAGE_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
};

function resolveImageFileCandidate(rawText) {
    if (typeof rawText !== 'string')
        return null;
    const lines = rawText
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#') && l !== 'copy' && l !== 'cut');
    if (lines.length !== 1)
        return null;

    let candidate = lines[0];
    if ((candidate.startsWith('"') && candidate.endsWith('"')) ||
        (candidate.startsWith("'") && candidate.endsWith("'"))) {
        candidate = candidate.slice(1, -1).trim();
    }

    let file = null;
    if (candidate.startsWith('file://')) {
        file = Gio.File.new_for_uri(candidate);
    } else if (candidate.startsWith('~/')) {
        const expanded = GLib.build_filenamev([GLib.get_home_dir(), candidate.slice(2)]);
        file = Gio.File.new_for_path(expanded);
    } else if (candidate.startsWith('/')) {
        file = Gio.File.new_for_path(candidate);
    } else {
        return null;
    }

    const path = file.get_path();
    if (!path)
        return null;
    const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
    const mimeType = match ? EXT_TO_IMAGE_MIME[match[1]] : null;
    if (!mimeType)
        return null;

    return {file, mimeType};
}

function loadFileBytesAsync(file) {
    return new Promise(resolve => {
        file.load_contents_async(null, (src, res) => {
            try {
                const [ok, raw] = src.load_contents_finish(res);
                resolve(ok && raw && raw.length > 0 ? new GLib.Bytes(raw) : null);
            } catch {
                resolve(null);
            }
        });
    });
}

const ALWAYS_SENSITIVE_PREFIXES = [
    'application/x-keepassxc-',
    'application/x-gnome-password',
    'application/x-bitwarden-',
];

export class ClipboardWatcher {
    #selection = null;
    #clipboard = null;
    #cancellable = null;
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
        this.#cancellable = new Gio.Cancellable();
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
        const uriMime = URI_LIST_MIMETYPES.find(m => mimetypes.includes(m)) ?? null;
        const imageMime = IMAGE_MIMETYPES.find(m => mimetypes.includes(m)) ?? null;

        // 1. Prefer raw image clipboard data first so copied images don't get captured as filenames/URLs
        if (this.#captureImages && imageMime) {
            const maxBytes = this.#maxImageSizeMb * 1024 * 1024;
            const bytes = await this.#getContentAsync(imageMime, maxBytes + 1);
            if (this.#destroyed || this.#paused || seq !== this.#captureSeq)
                return;
            if (bytes) {
                const sizeBytes = bytes.get_size();
                if (sizeBytes > 0 && sizeBytes <= maxBytes) {
                    const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
                    if (!this.#isSuppressed(hash))
                        await this.#onImage?.(bytes, imageMime);
                    return;
                }
            }
        }

        // 2. Copied image files from file managers (text/uri-list or x-special/gnome-copied-files)
        if (this.#captureImages && uriMime) {
            const uriBytes = await this.#getContentAsync(uriMime, 64 * 1024);
            if (this.#destroyed || this.#paused || seq !== this.#captureSeq)
                return;
            if (uriBytes && uriBytes.get_size() > 0) {
                const decoded = this.#decoder.decode(uriBytes.get_data());
                if (await this.#tryCaptureImageFile(decoded, seq))
                    return;
            }
        }

        // 3. Text clipboard data (also upgrades single local image file paths to real images)
        if (hasTextMime) {
            const text = await this.#getTextAsync();
            if (this.#destroyed || this.#paused || seq !== this.#captureSeq)
                return;

            if (text && text.trim().length > 0) {
                if (this.#captureImages && await this.#tryCaptureImageFile(text, seq))
                    return;

                const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
                if (!this.#isSuppressed(hash))
                    await this.#onText?.(text);
                return;
            }
        }
    }

    async #tryCaptureImageFile(rawText, seq) {
        const candidate = resolveImageFileCandidate(rawText);
        if (!candidate)
            return false;

        try {
            const info = candidate.file.query_info(
                'standard::type,standard::size',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                return false;
            const sizeBytes = info.get_size();
            const maxBytes = this.#maxImageSizeMb * 1024 * 1024;
            if (sizeBytes <= 0 || sizeBytes > maxBytes)
                return false;
        } catch {
            return false;
        }

        const bytes = await loadFileBytesAsync(candidate.file);
        if (this.#destroyed || this.#paused || seq !== this.#captureSeq || !bytes)
            return false;

        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        if (!this.#isSuppressed(hash))
            await this.#onImage?.(bytes, candidate.mimeType);
        return true;
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
        const hintBytes = await this.#getContentAsync(kdeHintMime, 256);
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

    #getContentAsync(mimeType, maxBytes = -1) {
        // Transfer directly via Meta.Selection into our own MemoryOutputStream so
        // steal_as_bytes() returns a transfer-full GBytes owned by GJS (avoids the
        // transfer-none GBytes use-after-free in St.Clipboard.get_content()) and
        // enforces a hard byte cap + cancellation inside Mutter.
        return new Promise(resolve => {
            if (this.#destroyed || !this.#selection) {
                resolve(null);
                return;
            }
            const stream = Gio.MemoryOutputStream.new_resizable();
            this.#selection.transfer_async(
                SELECTION_TYPE,
                mimeType,
                maxBytes,
                stream,
                this.#cancellable,
                (selection, res) => {
                    try {
                        const ok = selection.transfer_finish(res);
                        try {
                            stream.close(null);
                        } catch {
                            // already closed by mutter
                        }
                        if (!ok || this.#destroyed) {
                            resolve(null);
                            return;
                        }
                        const bytes = stream.steal_as_bytes();
                        resolve(bytes && bytes.get_size() > 0 ? bytes : null);
                    } catch {
                        try {
                            stream.close(null);
                        } catch {
                            // ignore
                        }
                        resolve(null);
                    }
                }
            );
        });
    }

    destroy() {
        this.#destroyed = true;
        this.#captureSeq++;
        this.#cancelDebounce();
        if (this.#cancellable) {
            this.#cancellable.cancel();
            this.#cancellable = null;
        }
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
