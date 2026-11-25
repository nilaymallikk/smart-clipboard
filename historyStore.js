import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

const THUMB_MAX_WIDTH = 240;
const THUMB_MAX_HEIGHT = 96;
const MAX_TEXT_LENGTH = 512 * 1024; // 512K chars cap so huge accidental text copies never stall JSON serialization

const MIME_TO_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
};

function loadContentsAsync(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (src, res) => {
            try {
                const [, bytes] = src.load_contents_finish(res);
                resolve(bytes);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function replaceBytesAsync(file, glibBytes, cancellable) {
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(
            glibBytes,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            cancellable,
            (src, res) => {
                try {
                    src.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

function deleteFileAsync(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.delete_async(GLib.PRIORITY_DEFAULT, cancellable, (src, res) => {
            try {
                src.delete_finish(res);
                resolve(true);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                    resolve(false);
                    return;
                }
                reject(e);
            }
        });
    });
}

async function ensureDirAsync(dirFile, cancellable) {
    const parent = dirFile.get_parent();
    if (parent && parent.get_path() !== dirFile.get_path()) {
        // Attempt direct creation first; only recurse to parent on NOT_FOUND
        try {
            await makeDirSingleAsync(dirFile, cancellable);
            return;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                return;
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                await ensureDirAsync(parent, cancellable);
                await makeDirSingleAsync(dirFile, cancellable);
                return;
            }
            throw e;
        }
    }
}

function makeDirSingleAsync(dirFile, cancellable) {
    return new Promise((resolve, reject) => {
        dirFile.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable, (src, res) => {
            try {
                src.make_directory_finish(res);
                resolve();
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                    resolve();
                    return;
                }
                reject(e);
            }
        });
    });
}

async function listDirNamesAsync(dirFile, cancellable) {
    let enumerator;
    try {
        enumerator = await new Promise((resolve, reject) => {
            dirFile.enumerate_children_async(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (src, res) => {
                    try {
                        resolve(src.enumerate_children_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return [];
        throw e;
    }

    const names = [];
    try {
        while (true) {
            const infos = await new Promise((resolve, reject) => {
                enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, cancellable, (src, res) => {
                    try {
                        resolve(src.next_files_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            if (!infos || infos.length === 0)
                break;
            for (const info of infos) {
                if (info.get_file_type() === Gio.FileType.REGULAR)
                    names.push(info.get_name());
            }
        }
    } finally {
        enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (src, res) => {
            try {
                src.close_finish(res);
            } catch {
                // ignore close errors
            }
        });
    }
    return names;
}

async function saveThumbnailAsync(glibBytes, thumbFile, cancellable) {
    const memStream = Gio.MemoryInputStream.new_from_bytes(glibBytes);
    const pixbuf = await new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
            memStream,
            THUMB_MAX_WIDTH,
            THUMB_MAX_HEIGHT,
            true,
            cancellable,
            (_src, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });

    const outStream = await new Promise((resolve, reject) => {
        thumbFile.replace_async(
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (src, res) => {
                try {
                    resolve(src.replace_finish(res));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });

    try {
        await new Promise((resolve, reject) => {
            pixbuf.save_to_streamv_async(outStream, 'png', [], [], cancellable, (_src, res) => {
                try {
                    GdkPixbuf.Pixbuf.save_to_stream_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    } finally {
        await new Promise(resolve => {
            outStream.close_async(GLib.PRIORITY_DEFAULT, null, (src, res) => {
                try {
                    src.close_finish(res);
                } catch {
                    // ignore close errors
                }
                resolve();
            });
        });
    }
}

/**
 * Parse pixel dimensions from common image headers in memory without full decode.
 */
function parseImageDimensions(data) {
    if (!data || data.length < 24)
        return {width: 0, height: 0};

    // PNG: 8-byte signature + IHDR length/type + width(4) + height(4)
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
        const width = ((data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19]) >>> 0;
        const height = ((data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23]) >>> 0;
        return {width, height};
    }

    // GIF: "GIF8" + width(LE16) + height(LE16)
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
        const width = data[6] | (data[7] << 8);
        const height = data[8] | (data[9] << 8);
        return {width, height};
    }

    // JPEG: scan SOF0/SOF1/SOF2 markers
    if (data[0] === 0xFF && data[1] === 0xD8) {
        let offset = 2;
        while (offset + 9 < data.length) {
            if (data[offset] !== 0xFF)
                break;
            const marker = data[offset + 1];
            if (marker === 0xD9 || marker === 0xDA)
                break;
            const len = (data[offset + 2] << 8) | data[offset + 3];
            if (len < 2)
                break;
            if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
                const height = (data[offset + 5] << 8) | data[offset + 6];
                const width = (data[offset + 7] << 8) | data[offset + 8];
                return {width, height};
            }
            offset += 2 + len;
        }
    }

    return {width: 0, height: 0};
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return '0 B';
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function scoreMatch(haystackLower, queryLower) {
    if (!queryLower)
        return 1;

    const exactIdx = haystackLower.indexOf(queryLower);
    if (exactIdx !== -1)
        return 1000 - Math.min(exactIdx, 500);

    // Multi-word AND substring match
    const tokens = queryLower.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
        let allHit = true;
        let totalIdx = 0;
        for (const tok of tokens) {
            const idx = haystackLower.indexOf(tok);
            if (idx === -1) {
                allHit = false;
                break;
            }
            totalIdx += idx;
        }
        if (allHit)
            return 500 - Math.min(totalIdx, 300);
    }

    // Ordered fuzzy subsequence match
    let qi = 0;
    let firstHit = -1;
    let lastHit = -1;
    for (let i = 0; i < haystackLower.length && qi < queryLower.length; i++) {
        if (haystackLower[i] === queryLower[qi]) {
            if (firstHit === -1)
                firstHit = i;
            lastHit = i;
            qi++;
        }
    }
    if (qi === queryLower.length) {
        const span = Math.max(1, lastHit - firstHit + 1);
        return Math.max(1, 200 - Math.min(span, 199));
    }

    return 0;
}

export class HistoryStore {
    #cacheDir;
    #imagesDir;
    #thumbsDir;
    #historyFile;
    #entries = [];
    #config;
    #onChanged;
    #cancellable = new Gio.Cancellable();
    #writing = false;
    #pendingPayload = null;
    #destroyed = false;
    #decoder = new TextDecoder('utf-8');
    #encoder = new TextEncoder();

    constructor({uuid, cacheDir = null, config = {}, onChanged = null}) {
        this.#cacheDir = cacheDir ?? GLib.build_filenamev([GLib.get_user_cache_dir(), uuid]);
        this.#imagesDir = GLib.build_filenamev([this.#cacheDir, 'images']);
        this.#thumbsDir = GLib.build_filenamev([this.#cacheDir, 'thumbs']);
        this.#historyFile = Gio.File.new_for_path(GLib.build_filenamev([this.#cacheDir, 'history.json']));
        this.#config = {
            maxTextHistory: 50,
            maxImageHistory: 20,
            maxImageSizeMb: 10,
            persistHistory: true,
            ...config,
        };
        this.#onChanged = onChanged;
    }

    get cacheDir() {
        return this.#cacheDir;
    }

    get entries() {
        return this.#entries;
    }

    setConfig(partial) {
        const prevPersist = this.#config.persistHistory;
        this.#config = {...this.#config, ...partial};

        const pruned = this.#enforceLimits();
        if (prevPersist && !this.#config.persistHistory) {
            this.#removeHistoryFileAsync();
        } else if (!prevPersist && this.#config.persistHistory) {
            this.#scheduleSave();
        } else if (pruned) {
            this.#scheduleSave();
        }

        if (pruned)
            this.#emitChanged();
    }

    async load() {
        if (this.#destroyed)
            return;

        await this.#ensureCacheDirsAsync();

        if (!this.#config.persistHistory) {
            this.#entries = [];
            await this.#removeHistoryFileAsync();
            await this.pruneOrphanFiles();
            this.#emitChanged();
            return;
        }

        try {
            const rawBytes = await loadContentsAsync(this.#historyFile, this.#cancellable);
            if (this.#destroyed)
                return;

            const parsed = JSON.parse(this.#decoder.decode(rawBytes));
            if (Array.isArray(parsed)) {
                this.#entries = parsed
                    .filter(item => item && typeof item === 'object' && typeof item.hash === 'string')
                    .filter(item => (item.type === 'text' && typeof item.text === 'string') ||
                        (item.type === 'image' && typeof item.imageFile === 'string'));
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) &&
                !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                console.warn(`[smart-clipboard] Failed to load history.json: ${e.message}`);
            }
            this.#entries = [];
        }

        if (this.#destroyed)
            return;

        // Verify referenced image files still exist on disk asynchronously
        const imageNames = new Set(await listDirNamesAsync(Gio.File.new_for_path(this.#imagesDir), this.#cancellable));
        if (this.#destroyed)
            return;

        this.#entries = this.#entries.filter(e => e.type !== 'image' || imageNames.has(e.imageFile));
        this.#sortEntries();
        this.#enforceLimits();
        await this.pruneOrphanFiles();
        this.#emitChanged();
    }

    async addText(text) {
        if (this.#destroyed || typeof text !== 'string')
            return null;

        if (text.trim().length === 0)
            return null;

        const clipped = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, clipped, -1);
        const now = Date.now();

        const existingIdx = this.#entries.findIndex(e => e.type === 'text' && e.hash === hash);
        let entry;
        if (existingIdx !== -1) {
            entry = this.#entries.splice(existingIdx, 1)[0];
            entry.updatedAt = now;
        } else {
            const lines = clipped.split(/\r?\n/);
            entry = {
                id: `${now}-${hash.slice(0, 8)}`,
                type: 'text',
                hash,
                text: clipped,
                charCount: clipped.length,
                lineCount: lines.length,
                isUrl: /^https?:\/\/\S+$/i.test(clipped.trim()),
                pinned: false,
                updatedAt: now,
            };
        }

        this.#entries.unshift(entry);
        this.#sortEntries();
        this.#enforceLimits();
        this.#scheduleSave();
        this.#emitChanged();
        return entry;
    }

    async addImage(glibBytes, mimeType) {
        if (this.#destroyed || !glibBytes)
            return null;

        const sizeBytes = glibBytes.get_size();
        const maxBytes = this.#config.maxImageSizeMb * 1024 * 1024;
        if (sizeBytes <= 0 || sizeBytes > maxBytes)
            return null;

        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, glibBytes);
        const now = Date.now();

        const existingIdx = this.#entries.findIndex(e => e.type === 'image' && e.hash === hash);
        if (existingIdx !== -1) {
            const existing = this.#entries.splice(existingIdx, 1)[0];
            existing.updatedAt = now;
            this.#entries.unshift(existing);
            this.#sortEntries();
            this.#scheduleSave();
            this.#emitChanged();
            return existing;
        }

        await this.#ensureCacheDirsAsync();
        if (this.#destroyed)
            return null;

        const ext = MIME_TO_EXT[mimeType] ?? 'png';
        const imageFileName = `${hash}.${ext}`;
        const thumbFileName = `${hash}.png`;
        const imageFile = Gio.File.new_for_path(GLib.build_filenamev([this.#imagesDir, imageFileName]));
        const thumbFile = Gio.File.new_for_path(GLib.build_filenamev([this.#thumbsDir, thumbFileName]));

        const {width, height} = parseImageDimensions(glibBytes.get_data());

        await replaceBytesAsync(imageFile, glibBytes, this.#cancellable);
        if (this.#destroyed)
            return null;

        let hasThumb = false;
        try {
            await saveThumbnailAsync(glibBytes, thumbFile, this.#cancellable);
            hasThumb = true;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`[smart-clipboard] Thumbnail generation failed: ${e.message}`);
        }

        if (this.#destroyed)
            return null;

        // Re-check deduplication in case an identical copy landed while writing
        const dupIdx = this.#entries.findIndex(e => e.type === 'image' && e.hash === hash);
        if (dupIdx !== -1)
            this.#entries.splice(dupIdx, 1);

        const entry = {
            id: `${now}-${hash.slice(0, 8)}`,
            type: 'image',
            hash,
            mimeType,
            imageFile: imageFileName,
            thumbFile: hasThumb ? thumbFileName : null,
            width,
            height,
            sizeBytes,
            pinned: false,
            updatedAt: now,
        };

        this.#entries.unshift(entry);
        this.#sortEntries();
        this.#enforceLimits();
        this.#scheduleSave();
        this.#emitChanged();
        return entry;
    }

    getImageFile(entry) {
        if (!entry || entry.type !== 'image' || !entry.imageFile)
            return null;
        return Gio.File.new_for_path(GLib.build_filenamev([this.#imagesDir, entry.imageFile]));
    }

    getThumbFile(entry) {
        if (!entry || entry.type !== 'image')
            return null;
        if (entry.thumbFile)
            return Gio.File.new_for_path(GLib.build_filenamev([this.#thumbsDir, entry.thumbFile]));
        return this.getImageFile(entry);
    }

    async readImageBytes(entry) {
        const file = this.getImageFile(entry);
        if (!file)
            return null;
        const raw = await loadContentsAsync(file, this.#cancellable);
        return new GLib.Bytes(raw);
    }

    togglePin(id) {
        const entry = this.#entries.find(e => e.id === id);
        if (!entry)
            return false;
        entry.pinned = !entry.pinned;
        entry.updatedAt = Date.now();
        this.#sortEntries();
        this.#enforceLimits();
        this.#scheduleSave();
        this.#emitChanged();
        return entry.pinned;
    }

    deleteItem(id) {
        const idx = this.#entries.findIndex(e => e.id === id);
        if (idx === -1)
            return false;
        const [removed] = this.#entries.splice(idx, 1);
        this.#deleteEntryFilesAsync(removed);
        this.#scheduleSave();
        this.#emitChanged();
        return true;
    }

    clearUnpinned() {
        const removed = [];
        const kept = [];
        for (const entry of this.#entries) {
            if (entry.pinned)
                kept.push(entry);
            else
                removed.push(entry);
        }
        if (removed.length === 0)
            return 0;

        this.#entries = kept;
        for (const entry of removed)
            this.#deleteEntryFilesAsync(entry);
        this.#scheduleSave();
        this.#emitChanged();
        return removed.length;
    }

    async wipeAll() {
        const removed = this.#entries;
        this.#entries = [];
        this.#pendingPayload = null;
        this.#emitChanged();

        for (const entry of removed)
            this.#deleteEntryFilesAsync(entry);

        await this.#removeHistoryFileAsync();
        await this.pruneOrphanFiles();
    }

    filter(query) {
        const q = (query ?? '').trim().toLowerCase();
        if (!q)
            return [...this.#entries];

        const scored = [];
        for (const entry of this.#entries) {
            const hay = entry.type === 'text'
                ? entry.text.toLowerCase()
                : `${entry.mimeType} image ${entry.width || ''}x${entry.height || ''} ${formatBytes(entry.sizeBytes)}`.toLowerCase();
            const score = scoreMatch(hay, q);
            if (score > 0)
                scored.push({entry, score});
        }

        scored.sort((a, b) => {
            const aStrong = a.score >= 500;
            const bStrong = b.score >= 500;
            if (aStrong !== bStrong)
                return aStrong ? -1 : 1;
            if (a.entry.pinned !== b.entry.pinned)
                return a.entry.pinned ? -1 : 1;
            if (b.score !== a.score)
                return b.score - a.score;
            return b.entry.updatedAt - a.entry.updatedAt;
        });

        return scored.map(s => s.entry);
    }

    async pruneOrphanFiles() {
        if (this.#destroyed)
            return;

        const referencedImages = new Set();
        const referencedThumbs = new Set();
        for (const entry of this.#entries) {
            if (entry.type === 'image') {
                if (entry.imageFile)
                    referencedImages.add(entry.imageFile);
                if (entry.thumbFile)
                    referencedThumbs.add(entry.thumbFile);
            }
        }

        await this.#pruneDirAsync(this.#imagesDir, referencedImages);
        await this.#pruneDirAsync(this.#thumbsDir, referencedThumbs);
    }

    async #pruneDirAsync(dirPath, keepSet) {
        const dirFile = Gio.File.new_for_path(dirPath);
        let names;
        try {
            names = await listDirNamesAsync(dirFile, this.#cancellable);
        } catch {
            return;
        }
        const deletions = [];
        for (const name of names) {
            if (!keepSet.has(name)) {
                const f = Gio.File.new_for_path(GLib.build_filenamev([dirPath, name]));
                deletions.push(deleteFileAsync(f, this.#cancellable).catch(() => {}));
            }
        }
        await Promise.all(deletions);
    }

    #sortEntries() {
        this.#entries.sort((a, b) => {
            if (a.pinned !== b.pinned)
                return a.pinned ? -1 : 1;
            return b.updatedAt - a.updatedAt;
        });
    }

    #enforceLimits() {
        let textCount = 0;
        let imageCount = 0;
        const kept = [];
        const removed = [];

        for (const entry of this.#entries) {
            if (entry.pinned) {
                kept.push(entry);
                continue;
            }
            if (entry.type === 'text') {
                if (textCount < this.#config.maxTextHistory) {
                    textCount++;
                    kept.push(entry);
                } else {
                    removed.push(entry);
                }
            } else if (entry.type === 'image') {
                if (imageCount < this.#config.maxImageHistory) {
                    imageCount++;
                    kept.push(entry);
                } else {
                    removed.push(entry);
                }
            }
        }

        if (removed.length === 0)
            return false;

        this.#entries = kept;
        for (const entry of removed)
            this.#deleteEntryFilesAsync(entry);
        return true;
    }

    #deleteEntryFilesAsync(entry) {
        if (!entry || entry.type !== 'image')
            return;
        if (entry.imageFile) {
            const imgFile = Gio.File.new_for_path(GLib.build_filenamev([this.#imagesDir, entry.imageFile]));
            deleteFileAsync(imgFile, null).catch(() => {});
        }
        if (entry.thumbFile) {
            const thumbFile = Gio.File.new_for_path(GLib.build_filenamev([this.#thumbsDir, entry.thumbFile]));
            deleteFileAsync(thumbFile, null).catch(() => {});
        }
    }

    async #ensureCacheDirsAsync() {
        await ensureDirAsync(Gio.File.new_for_path(this.#cacheDir), this.#cancellable);
        await ensureDirAsync(Gio.File.new_for_path(this.#imagesDir), this.#cancellable);
        await ensureDirAsync(Gio.File.new_for_path(this.#thumbsDir), this.#cancellable);
    }

    #scheduleSave() {
        if (this.#destroyed || !this.#config.persistHistory)
            return;

        this.#pendingPayload = JSON.stringify(this.#entries);
        if (!this.#writing)
            this.#flushSave();
    }

    async #flushSave() {
        if (this.#destroyed || this.#pendingPayload === null)
            return;

        this.#writing = true;
        try {
            await this.#ensureCacheDirsAsync();
            while (!this.#destroyed && this.#pendingPayload !== null && this.#config.persistHistory) {
                const payload = this.#pendingPayload;
                this.#pendingPayload = null;
                const bytes = new GLib.Bytes(this.#encoder.encode(payload));
                await replaceBytesAsync(this.#historyFile, bytes, this.#cancellable);
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`[smart-clipboard] Failed to save history.json: ${e.message}`);
        } finally {
            this.#writing = false;
        }
    }

    async #removeHistoryFileAsync() {
        try {
            await deleteFileAsync(this.#historyFile, null);
        } catch {
            // ignore
        }
    }

    #emitChanged() {
        if (!this.#destroyed && this.#onChanged)
            this.#onChanged(this.#entries);
    }

    destroy() {
        this.#destroyed = true;
        this.#cancellable.cancel();
        this.#pendingPayload = null;
        this.#onChanged = null;
        this.#entries = [];
    }
}
