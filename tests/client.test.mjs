import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    PIN_DRAG_MIME,
    buildDragContentProvider,
    filterEntries,
    formatRelativeTime,
    formatTextPreview,
    parseCssColor,
} from '../popupClient.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`ASSERTION FAILED: ${msg}`);
}

const tmpDir = GLib.dir_make_tmp('smart-clipboard-client-test-XXXXXX');

try {
    // Relative time formatting
    const now = 1_700_000_000_000;
    assert(formatRelativeTime(now - 5_000, now) === 'Just now', 'just now');
    assert(formatRelativeTime(now - 35_000, now) === '35s ago', 'seconds ago');
    assert(formatRelativeTime(now - 5 * 60_000, now) === '5m ago', 'minutes ago');
    assert(formatRelativeTime(now - 3 * 3_600_000, now) === '3h ago', 'hours ago');
    assert(formatRelativeTime(now - 30 * 3_600_000, now) === 'Yesterday', 'yesterday');

    // Text preview collapsing & truncation
    assert(formatTextPreview('  line 1 \n\n  line 2 \n line 3 ') === 'line 1\nline 2', 'preserves clean 2 lines');
    assert(formatTextPreview('  line 1 \n\n  line 2 ', 2, 140, ' ↵ ') === 'line 1 ↵ line 2', 'supports custom separator');
    assert(formatTextPreview('a'.repeat(200), 2, 20).endsWith('…'), 'ellipsizes long preview');

    // Color parsing
    const hex6 = parseCssColor('#3584e4');
    assert(hex6 && hex6.r === 53 && hex6.g === 132 && hex6.b === 228, 'parses 6-digit hex');
    const hex3 = parseCssColor('#f0a');
    assert(hex3 && hex3.r === 255 && hex3.g === 0 && hex3.b === 170, 'parses 3-digit hex');
    const rgba = parseCssColor('rgba(10, 20, 30, 0.5)');
    assert(rgba && rgba.r === 10 && rgba.g === 20 && rgba.b === 30 && rgba.a === 0.5, 'parses rgba');
    assert(parseCssColor('not a color') === null, 'rejects invalid color');

    // Filtering by category & sourceApp
    const sample = [
        {id: '1', type: 'text', subtype: 'color', text: '#3584e4', pinned: true, sourceApp: 'Figma', updatedAt: 100},
        {id: '2', type: 'text', subtype: 'url', isUrl: true, text: 'https://gnome.org', pinned: false, sourceApp: 'Firefox', updatedAt: 200},
        {id: '3', type: 'text', subtype: 'code', isJson: true, text: '{"k":1}', pinned: false, sourceApp: 'VS Code', updatedAt: 300},
        {id: '4', type: 'image', mimeType: 'image/png', width: 100, height: 50, sizeBytes: 1024, pinned: false, sourceApp: 'Screenshot', updatedAt: 400},
    ];
    assert(filterEntries(sample, '', 'pinned').length === 1, 'pinned filter');
    assert(filterEntries(sample, '', 'image').length === 1, 'image filter');
    assert(filterEntries(sample, '', 'url')[0].id === '2', 'url filter');
    assert(filterEntries(sample, '', 'code')[0].id === '3', 'code filter');
    assert(filterEntries(sample, '', 'color')[0].id === '1', 'color filter');
    assert(filterEntries(sample, 'firefox', 'all')[0].id === '2', 'matches sourceApp');

    // Drag ContentProvider for text + URL + pinned
    const urlProvider = buildDragContentProvider(sample[1], Gdk, {includePinOrder: false});
    const urlFormats = urlProvider.ref_formats().to_string();
    assert(urlFormats.includes('text/plain;charset=utf-8'), `URL drag includes text/plain (${urlFormats})`);
    assert(urlFormats.includes('text/uri-list'), `URL drag includes text/uri-list (${urlFormats})`);

    const pinnedProvider = buildDragContentProvider(sample[0], Gdk, {includePinOrder: true});
    const pinnedFormats = pinnedProvider.ref_formats().to_string();
    assert(pinnedFormats.includes(PIN_DRAG_MIME), `pinned drag includes reorder mime (${pinnedFormats})`);

    // Drag ContentProvider for image file on disk
    const imgPath = GLib.build_filenamev([tmpDir, 'sample.png']);
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, 32, 32);
    pb.fill(0x3584e4ff);
    pb.savev(imgPath, 'png', [], []);

    const imgEntry = {
        id: 'img-1',
        type: 'image',
        mimeType: 'image/png',
        imagePath: imgPath,
        pinned: true,
    };
    const imgProvider = buildDragContentProvider(imgEntry, Gdk, {includePinOrder: true});
    const imgFormats = imgProvider.ref_formats().to_string();
    assert(imgFormats.includes('GdkFileList'), `image drag includes GdkFileList (${imgFormats})`);
    assert(imgFormats.includes('text/uri-list'), `image drag includes text/uri-list (${imgFormats})`);
    assert(imgFormats.includes('image/png'), `image drag includes image/png (${imgFormats})`);
    assert(imgFormats.includes(PIN_DRAG_MIME), `pinned image drag includes reorder mime (${imgFormats})`);

    // Verify file exists check fails safely when path missing
    const missingProvider = buildDragContentProvider({id: 'x', type: 'image', imagePath: '/nonexistent/foo.png'}, Gdk);
    assert(missingProvider === null, 'missing image returns null provider cleanly');

    print('ALL CLIENT TESTS PASSED');
} finally {
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(tmpDir)}`);
}
