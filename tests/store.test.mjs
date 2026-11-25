import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import {HistoryStore, classifyText, scoreMatch} from '../historyStore.js';

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

    // Classification checks
    assert(classifyText('#3584e4').subtype === 'color', 'detects hex color');
    assert(classifyText('rgb(53, 132, 228)').subtype === 'color', 'detects rgb color');
    assert(classifyText('https://github.com/nilaymallikk').subtype === 'url', 'detects URL');
    assert(classifyText('dev@example.com').subtype === 'email', 'detects email');
    const jsonCls = classifyText('{"name":"smart-clipboard","v":2}');
    assert(jsonCls.subtype === 'code' && jsonCls.isJson === true, 'detects JSON as code');
    assert(classifyText('const fn = (x) => x * 2;').subtype === 'code', 'detects JS code');
    assert(classifyText('just a normal note').subtype === 'text', 'detects plain text');

    // Source app + category filtering + inline edit + pin reorder + undo
    const colorEntry = await store.addText('#ff5500', {sourceApp: 'Figma'});
    const urlEntry = await store.addText('https://gnome.org', {sourceApp: 'Firefox'});
    const codeEntry = await store.addText('{"ok": true}', {sourceApp: 'VS Code'});
    assert(colorEntry.subtype === 'color' && colorEntry.sourceApp === 'Figma', 'stores subtype & sourceApp');
    assert(store.filter('', 'color').some(e => e.id === colorEntry.id), 'color category filter works');
    assert(store.filter('', 'url').some(e => e.id === urlEntry.id), 'url category filter works');
    assert(store.filter('', 'code').some(e => e.id === codeEntry.id), 'code category filter works');
    assert(store.filter('firefox').some(e => e.id === urlEntry.id), 'search matches sourceApp');

    // Pin multiple items and reorder them
    store.togglePin(colorEntry.id);
    store.togglePin(urlEntry.id);
    assert(store.entries[0].id === urlEntry.id, 'newly pinned goes to top');
    assert(store.reorderPinned(colorEntry.id, urlEntry.id), 'reorderPinned succeeds');
    assert(store.entries[0].id === colorEntry.id && store.entries[1].id === urlEntry.id, 'pinned order updated');

    // Inline text edit updates hash, metadata, classification
    const edited = store.updateText(codeEntry.id, 'https://edited.example.com');
    assert(edited && edited.subtype === 'url' && edited.isUrl, 'updateText reclassifies edited text');

    // Delete & Undo restores item (including images!)
    const undoImg = await store.addImage(makeTestPngBytes(50, 50), 'image/png', {sourceApp: 'Screenshot'});
    const serializable = store.getSerializableEntries();
    const serImg = serializable.find(e => e.id === undoImg.id);
    assert(serImg && serImg.imagePath && serImg.thumbPath, 'getSerializableEntries resolves paths');
    assert(store.deleteItem(undoImg.id), 'deleteItem removes image');
    assert(!store.getEntry(undoImg.id), 'image removed from entries');
    assert(store.canUndo, 'canUndo is true after delete');
    assert(store.undoLastDelete() === 1, 'undoLastDelete restores 1 item');
    assert(Boolean(store.getEntry(undoImg.id)), 'restored image back in store');
    assert(store.getImageFile(undoImg).query_exists(null), 'restored image file preserved on disk');

    // Clear unpinned preserves pinned & can be undone
    store.togglePin(colorEntry.id); // unpin colorEntry
    store.togglePin(urlEntry.id);   // unpin urlEntry
    const clearedCount = store.clearUnpinned();
    assert(clearedCount >= 1, 'clearUnpinned removes unpinned items');
    assert(store.entries.length === 1 && store.entries[0].id === b.id, 'clearUnpinned keeps only pinned');
    assert(store.undoLastDelete() === clearedCount, 'undo restores cleared unpinned items');
    store.clearUnpinned();
    assert(store.entries.length === 1 && store.entries[0].id === b.id, 'clearUnpinned again leaves only pinned');

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
