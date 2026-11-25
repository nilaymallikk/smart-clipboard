import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {
    SERVICE_BUS_NAME,
    SERVICE_IFACE_NAME,
    SERVICE_OBJECT_PATH,
} from './dbusService.js';
import {formatBytes, scoreMatch} from './historyStore.js';

export const PIN_DRAG_MIME = 'application/x-smart-clipboard-pin-id';
const ENCODER = new TextEncoder();

const EXT_TO_IMAGE_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
};

export function resolveEntryImage(entry) {
    if (!entry)
        return null;

    if (entry.type === 'image') {
        const path = entry.imagePath || entry.thumbPath || null;
        if (!path)
            return null;
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null))
            return null;
        return {
            path,
            thumbPath: entry.thumbPath || path,
            mimeType: entry.mimeType || 'image/png',
            file,
        };
    }

    if (entry.type === 'text' && typeof entry.text === 'string') {
        const trimmed = entry.text.trim();
        if (!trimmed || trimmed.includes('\n'))
            return null;

        let candidate = trimmed;
        if ((candidate.startsWith('"') && candidate.endsWith('"')) ||
            (candidate.startsWith("'") && candidate.endsWith("'"))) {
            candidate = candidate.slice(1, -1).trim();
        }

        let file = null;
        if (candidate.startsWith('file://')) {
            file = Gio.File.new_for_uri(candidate);
        } else if (candidate.startsWith('~/')) {
            file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_home_dir(), candidate.slice(2)]));
        } else if (candidate.startsWith('/')) {
            file = Gio.File.new_for_path(candidate);
        } else {
            return null;
        }

        const path = file.get_path();
        if (!path)
            return null;
        const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
        const mimeType = m ? EXT_TO_IMAGE_MIME[m[1]] : null;
        if (!mimeType || !file.query_exists(null))
            return null;

        return {path, thumbPath: path, mimeType, file};
    }

    return null;
}

export {formatBytes};

export function formatRelativeTime(timestampMs, nowMs = Date.now()) {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0)
        return '';
    const diffSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
    if (diffSec < 15)
        return 'Just now';
    if (diffSec < 60)
        return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60)
        return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24)
        return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays === 1)
        return 'Yesterday';
    if (diffDays < 7)
        return `${diffDays}d ago`;
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(timestampMs / 1000));
    return dt ? dt.format('%b %e') : '';
}

export function formatTextPreview(text, maxLines = 2, maxChars = 140, separator = '\n') {
    const rawLines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
    const kept = [];
    for (const line of rawLines) {
        const cleaned = line.replace(/\t/g, '  ').trimEnd();
        if (cleaned.trim().length > 0)
            kept.push(cleaned.trimStart());
        if (kept.length >= maxLines)
            break;
    }
    let out = kept.join(separator);
    if (!out)
        out = (text ?? '').trim();
    if (out.length > maxChars)
        out = `${out.slice(0, maxChars - 1)}…`;
    return out;
}

export function parseCssColor(colorStr) {
    if (typeof colorStr !== 'string')
        return null;
    const s = colorStr.trim();

    const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (hex) {
        const raw = hex[1];
        let r, g, b, a = 1;
        if (raw.length === 3 || raw.length === 4) {
            r = parseInt(raw[0] + raw[0], 16);
            g = parseInt(raw[1] + raw[1], 16);
            b = parseInt(raw[2] + raw[2], 16);
            if (raw.length === 4)
                a = parseInt(raw[3] + raw[3], 16) / 255;
        } else {
            r = parseInt(raw.slice(0, 2), 16);
            g = parseInt(raw.slice(2, 4), 16);
            b = parseInt(raw.slice(4, 6), 16);
            if (raw.length === 8)
                a = parseInt(raw.slice(6, 8), 16) / 255;
        }
        return {r, g, b, a, css: s};
    }

    const rgb = s.match(/^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)$/i);
    if (rgb) {
        const r = Math.min(255, Math.max(0, Math.round(Number(rgb[1]))));
        const g = Math.min(255, Math.max(0, Math.round(Number(rgb[2]))));
        const b = Math.min(255, Math.max(0, Math.round(Number(rgb[3]))));
        let a = 1;
        if (rgb[4] !== undefined) {
            a = rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
            a = Math.min(1, Math.max(0, Number.isFinite(a) ? a : 1));
        }
        return {r, g, b, a, css: s};
    }

    if (/^hsla?\(/i.test(s))
        return {r: null, g: null, b: null, a: 1, css: s};

    return null;
}

export function filterEntries(entries, query, category = 'all') {
    const cat = (category ?? 'all').toLowerCase();
    const pool = cat === 'all'
        ? entries
        : entries.filter(entry => {
            switch (cat) {
            case 'pinned':
                return Boolean(entry.pinned);
            case 'text':
                return entry.type === 'text' && !resolveEntryImage(entry);
            case 'image':
                return entry.type === 'image' || Boolean(resolveEntryImage(entry));
            case 'url':
                return entry.type === 'text' && (entry.subtype === 'url' || entry.isUrl);
            case 'code':
                return entry.type === 'text' && entry.subtype === 'code';
            case 'color':
                return entry.type === 'text' && entry.subtype === 'color';
            default:
                return true;
            }
        });

    const q = (query ?? '').trim().toLowerCase();
    if (!q)
        return [...pool];

    const scored = [];
    for (const entry of pool) {
        const appTag = entry.sourceApp ? ` ${entry.sourceApp}` : '';
        const hay = entry.type === 'text'
            ? `${entry.text}${appTag} ${entry.subtype ?? ''}`.toLowerCase()
            : `${entry.mimeType} image ${entry.width || ''}x${entry.height || ''} ${formatBytes(entry.sizeBytes)}${appTag}`.toLowerCase();
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

/**
 * Build a multi-format Gdk.ContentProvider so any external Wayland/X11 app
 * (browsers, Slack/Discord, Files, GIMP, editors) accepts the dragged entry.
 */
export function buildDragContentProvider(entry, Gdk, {includePinOrder = false} = {}) {
    if (!entry)
        return null;

    const providers = [];

    if (includePinOrder && entry.pinned) {
        providers.push(Gdk.ContentProvider.new_for_bytes(
            PIN_DRAG_MIME,
            new GLib.Bytes(ENCODER.encode(entry.id))
        ));
    }

    const resolvedImage = resolveEntryImage(entry);
    if (resolvedImage) {
        const {file, mimeType} = resolvedImage;
        const fileList = Gdk.FileList.new_from_array([file]);
        const fileListVal = new GObject.Value();
        fileListVal.init(Gdk.FileList.$gtype);
        fileListVal.set_boxed(fileList);
        providers.push(Gdk.ContentProvider.new_for_value(fileListVal));

        const uriPayload = `${file.get_uri()}\r\n`;
        providers.push(Gdk.ContentProvider.new_for_bytes(
            'text/uri-list',
            new GLib.Bytes(ENCODER.encode(uriPayload))
        ));

        try {
            const [ok, rawBytes] = file.load_contents(null);
            if (ok && rawBytes && rawBytes.length > 0)
                providers.push(Gdk.ContentProvider.new_for_bytes(mimeType, new GLib.Bytes(rawBytes)));
        } catch (e) {
            console.warn(`[smart-clipboard] Drag image read failed: ${e.message}`);
        }
    } else if (entry.type === 'text') {
        const textVal = new GObject.Value();
        textVal.init(GObject.TYPE_STRING);
        textVal.set_string(entry.text);
        providers.push(Gdk.ContentProvider.new_for_value(textVal));

        providers.push(Gdk.ContentProvider.new_for_bytes(
            'text/plain;charset=utf-8',
            new GLib.Bytes(ENCODER.encode(entry.text))
        ));

        if (entry.isUrl || entry.subtype === 'url') {
            const uri = `${entry.text.trim()}\r\n`;
            providers.push(Gdk.ContentProvider.new_for_bytes(
                'text/uri-list',
                new GLib.Bytes(ENCODER.encode(uri))
            ));
        }
    }

    if (providers.length === 0)
        return null;
    if (providers.length === 1)
        return providers[0];
    return Gdk.ContentProvider.new_union(providers);
}

export class ClipboardServiceClient {
    #signalId = 0;
    #onChanged = null;

    constructor({onChanged = null} = {}) {
        this.#onChanged = onChanged;
        this.#signalId = Gio.DBus.session.signal_subscribe(
            SERVICE_BUS_NAME,
            SERVICE_IFACE_NAME,
            'Changed',
            SERVICE_OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            () => {
                this.#onChanged?.();
            }
        );
    }

    #call(method, params = null, replyType = null) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(
                SERVICE_BUS_NAME,
                SERVICE_OBJECT_PATH,
                SERVICE_IFACE_NAME,
                method,
                params,
                replyType,
                Gio.DBusCallFlags.NO_AUTO_START,
                2500,
                null,
                (conn, res) => {
                    try {
                        resolve(conn.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async getState() {
        const res = await this.#call('GetState', null, new GLib.VariantType('(s)'));
        const [json] = res.deepUnpack();
        return JSON.parse(json || '{}');
    }

    async copyEntry(id, paste = false) {
        const res = await this.#call('CopyEntry', new GLib.Variant('(sb)', [id, Boolean(paste)]), new GLib.VariantType('(b)'));
        return Boolean(res.deepUnpack()[0]);
    }

    async togglePin(id) {
        const res = await this.#call('TogglePin', new GLib.Variant('(s)', [id]), new GLib.VariantType('(b)'));
        return Boolean(res.deepUnpack()[0]);
    }

    async reorderPinned(sourceId, targetId) {
        const res = await this.#call('ReorderPinned', new GLib.Variant('(ss)', [sourceId, targetId]), new GLib.VariantType('(b)'));
        return Boolean(res.deepUnpack()[0]);
    }

    async deleteEntry(id) {
        const res = await this.#call('DeleteEntry', new GLib.Variant('(s)', [id]), new GLib.VariantType('(b)'));
        return Boolean(res.deepUnpack()[0]);
    }

    async clearUnpinned() {
        const res = await this.#call('ClearUnpinned', null, new GLib.VariantType('(u)'));
        return Number(res.deepUnpack()[0]);
    }

    async undoDelete() {
        const res = await this.#call('UndoDelete', null, new GLib.VariantType('(u)'));
        return Number(res.deepUnpack()[0]);
    }

    async setPaused(paused) {
        await this.#call('SetPaused', new GLib.Variant('(b)', [Boolean(paused)]), new GLib.VariantType('(b)'));
    }

    async openPreferences() {
        await this.#call('OpenPreferences', null, new GLib.VariantType('(b)'));
    }

    destroy() {
        if (this.#signalId !== 0) {
            Gio.DBus.session.signal_unsubscribe(this.#signalId);
            this.#signalId = 0;
        }
        this.#onChanged = null;
    }
}
