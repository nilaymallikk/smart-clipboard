import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import {HistoryStore, scoreMatch} from '../historyStore.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`ASSERTION FAILED: ${msg}`);
}

function makeTestPngBytes(width = 64, height = 32) {
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, width, height);
    pb.fill(0x3584e4ff);
    const [, buf] = pb.save_to_bufferv('png', [], []);
    return new GLib.Bytes(buf);
}

const tmpDir = GLib.dir_make_tmp('smart-clipboard-test-XXXXXX');

async function runTests() {
    const store = new HistoryStore({
        uuid: 'smart-clipboard@nilaymallik.local',
        cacheDir: tmpDir,
        config: {
            maxTextHistory: 3,
            maxImageHistory: 2,
            maxImageSizeMb: 5,
            persistHistory: true,
        },
    });

    await store.load();
    assert(store.entries.length === 0, 'starts empty');

    // Whitespace ignored
    assert((await store.addText('   \n\t  ')) === null, 'ignores whitespace-only text');

    // Add 3 text items
    const a = await store.addText('alpha item');
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => (r(), GLib.SOURCE_REMOVE)));
    const b = await store.addText('beta https://example.com');
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => (r(), GLib.SOURCE_REMOVE)));
    const c = await store.addText('gamma code snippet\nline 2');

    assert(store.entries.length === 3, '3 text entries present');
    assert(store.entries[0].id === c.id, 'newest at top');
    assert(c.lineCount === 2, 'counts lines');

    // Deduplicate: re-copying alpha moves it back to top without duplicate
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => (r(), GLib.SOURCE_REMOVE)));
    await store.addText('alpha item');
    assert(store.entries.length === 3, 'no duplicate created');
    assert(store.entries[0].id === a.id, 're-copied entry moved to top');

    // Pin beta, then add delta & epsilon -> beta stays at top, unpinned capped to 3
    store.togglePin(b.id);
    assert(store.entries[0].id === b.id && store.entries[0].pinned, 'pinned item stays at top');
    await store.addText('delta item');
    await store.addText('epsilon item');
    const unpinnedTexts = store.entries.filter(e => e.type === 'text' && !e.pinned);
    assert(unpinnedTexts.length === 3, `unpinned text pruned to max (got ${unpinnedTexts.length})`);
    assert(store.entries.some(e => e.id === b.id), 'pinned item exempt from pruning');

    // Image capture + thumbnail + dimensions + orphan cleanup on pruning
    const img1Bytes = makeTestPngBytes(120, 60);
    const img1 = await store.addImage(img1Bytes, 'image/png');
    assert(img1 !== null, 'image 1 saved');
    assert(img1.width === 120 && img1.height === 60, `parsed PNG dimensions (${img1.width}x${img1.height})`);
    assert(store.getImageFile(img1).query_exists(null), 'image 1 file exists on disk');
    assert(store.getThumbFile(img1).query_exists(null), 'thumb 1 file exists on disk');

    // Deduplicate identical image
    const img1Dup = await store.addImage(img1Bytes, 'image/png');
    assert(img1Dup.id === img1.id, 'duplicate image deduplicated by hash');

    // Add 2 more distinct images -> maxImageHistory=2 prunes img1 and cleans its files
    const img2 = await store.addImage(makeTestPngBytes(80, 40), 'image/png');
    const img3 = await store.addImage(makeTestPngBytes(90, 50), 'image/png');
    assert(img2 && img3, 'images 2 and 3 saved');

    // Allow async unlink microtasks to settle
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => (r(), GLib.SOURCE_REMOVE)));
    assert(!store.getImageFile(img1).query_exists(null), 'pruned image file deleted from disk');
    assert(!store.getThumbFile(img1).query_exists(null), 'pruned thumb file deleted from disk');

    // Read image bytes back from disk
    const restoredBytes = await store.readImageBytes(img3);
    assert(restoredBytes.get_size() > 0, 'read image bytes from disk');

    // Fuzzy & substring filter
    assert(scoreMatch('smart clipboard manager', 'scm') > 0, 'fuzzy subsequence matches');
    assert(scoreMatch('smart clipboard manager', 'clip') > scoreMatch('smart clipboard manager', 'scm'), 'substring ranks higher than fuzzy');
    const filtered = store.filter('eps');
    assert(filtered.length >= 1 && filtered[0].text === 'epsilon item', 'exact substring match ranks first even over pinned fuzzy match');

    // Clear unpinned preserves pinned
    store.clearUnpinned();
    assert(store.entries.length === 1 && store.entries[0].id === b.id, 'clearUnpinned keeps only pinned');

    // Wait briefly for coalesced async JSON save
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => (r(), GLib.SOURCE_REMOVE)));
    store.destroy();

    // Reload from disk in fresh store instance
    const store2 = new HistoryStore({
        uuid: 'smart-clipboard@nilaymallik.local',
        cacheDir: tmpDir,
        config: {persistHistory: true},
    });
    await store2.load();
    assert(store2.entries.length === 1 && store2.entries[0].text === 'beta https://example.com' && store2.entries[0].pinned,
        'persisted pinned entry restored after reload');

    // Wipe all
    await store2.wipeAll();
    assert(store2.entries.length === 0, 'wipeAll clears memory');
    assert(!Gio.File.new_for_path(GLib.build_filenamev([tmpDir, 'history.json'])).query_exists(null), 'history.json removed');
    store2.destroy();

    print('ALL STORE TESTS PASSED');
}

try {
    await runTests();
} finally {
    // Clean up temp test directory
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(tmpDir)}`);
}
