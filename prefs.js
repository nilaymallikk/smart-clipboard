import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DEFAULT_SHORTCUT = '<Super>v';

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return '0 B';
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function enumerateChildrenAsync(dir, attrs, cancellable) {
    return new Promise((resolve, reject) => {
        dir.enumerate_children_async(
            attrs,
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
}

function nextFilesAsync(enumerator, cancellable) {
    return new Promise((resolve, reject) => {
        enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, cancellable, (src, res) => {
            try {
                resolve(src.next_files_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function deleteFileAsync(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.delete_async(GLib.PRIORITY_DEFAULT, cancellable, (src, res) => {
            try {
                src.delete_finish(res);
                resolve();
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                    resolve();
                    return;
                }
                reject(e);
            }
        });
    });
}

async function computeDirStatsAsync(dirFile, cancellable) {
    let totalBytes = 0;
    let fileCount = 0;

    let enumerator;
    try {
        enumerator = await enumerateChildrenAsync(
            dirFile,
            'standard::name,standard::type,standard::size',
            cancellable
        );
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return {totalBytes: 0, fileCount: 0};
        throw e;
    }

    try {
        while (true) {
            const infos = await nextFilesAsync(enumerator, cancellable);
            if (!infos || infos.length === 0)
                break;
            for (const info of infos) {
                const type = info.get_file_type();
                const child = dirFile.get_child(info.get_name());
                if (type === Gio.FileType.DIRECTORY) {
                    const sub = await computeDirStatsAsync(child, cancellable);
                    totalBytes += sub.totalBytes;
                    fileCount += sub.fileCount;
                } else if (type === Gio.FileType.REGULAR) {
                    totalBytes += info.get_size();
                    fileCount++;
                }
            }
        }
    } finally {
        enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (src, res) => {
            try {
                src.close_finish(res);
            } catch {
                // ignore
            }
        });
    }

    return {totalBytes, fileCount};
}

async function wipeDirContentsAsync(dirFile, cancellable) {
    let enumerator;
    try {
        enumerator = await enumerateChildrenAsync(
            dirFile,
            'standard::name,standard::type',
            cancellable
        );
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return;
        throw e;
    }

    try {
        while (true) {
            const infos = await nextFilesAsync(enumerator, cancellable);
            if (!infos || infos.length === 0)
                break;
            for (const info of infos) {
                const child = dirFile.get_child(info.get_name());
                if (info.get_file_type() === Gio.FileType.DIRECTORY)
                    await wipeDirContentsAsync(child, cancellable);
                else
                    await deleteFileAsync(child, cancellable);
            }
        }
    } finally {
        enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (src, res) => {
            try {
                src.close_finish(res);
            } catch {
                // ignore
            }
        });
    }
}

function isModifierKey(keyval) {
    return [
        Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
        Gdk.KEY_Control_L, Gdk.KEY_Control_R,
        Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
        Gdk.KEY_Super_L, Gdk.KEY_Super_R,
        Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
        Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
        Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_Caps_Lock,
        Gdk.KEY_Num_Lock, Gdk.KEY_Scroll_Lock,
    ].includes(keyval);
}

export default class SmartClipboardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const cancellable = new Gio.Cancellable();
        const cacheDirPath = GLib.build_filenamev([GLib.get_user_cache_dir(), this.uuid]);
        const cacheDirFile = Gio.File.new_for_path(cacheDirPath);

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'edit-paste-symbolic',
        });
        window.add(page);

        // --- History Limits ---
        const limitsGroup = new Adw.PreferencesGroup({
            title: 'History Limits',
            description: 'Pinned items are always exempt from auto-pruning.',
        });
        page.add(limitsGroup);

        const maxTextRow = new Adw.SpinRow({
            title: 'Max text history entries',
            subtitle: 'Maximum number of unpinned text entries kept',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 500,
                step_increment: 5,
                page_increment: 25,
            }),
        });
        settings.bind('max-text-history', maxTextRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        limitsGroup.add(maxTextRow);

        const maxImageRow = new Adw.SpinRow({
            title: 'Max image history entries',
            subtitle: 'Maximum number of unpinned images cached on disk',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 200,
                step_increment: 1,
                page_increment: 10,
            }),
        });
        settings.bind('max-image-history', maxImageRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        limitsGroup.add(maxImageRow);

        const maxImageSizeRow = new Adw.SpinRow({
            title: 'Max single image size (MB)',
            subtitle: 'Copied images larger than this limit are skipped',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        settings.bind('max-image-size-mb', maxImageSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        limitsGroup.add(maxImageSizeRow);

        // --- Capture & Privacy ---
        const behaviorGroup = new Adw.PreferencesGroup({
            title: 'Capture &amp; Privacy',
        });
        page.add(behaviorGroup);

        const captureImagesRow = new Adw.SwitchRow({
            title: 'Capture images',
            subtitle: 'Save copied images and thumbnails to disk cache',
        });
        settings.bind('capture-images', captureImagesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(captureImagesRow);

        const persistRow = new Adw.SwitchRow({
            title: 'Persist history across sessions',
            subtitle: 'Restore saved clipboard entries after reboot or re-login',
        });
        settings.bind('persist-history', persistRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(persistRow);

        const privateRow = new Adw.SwitchRow({
            title: 'Pause / Private Mode',
            subtitle: 'Temporarily stop recording new clipboard entries',
        });
        settings.bind('private-mode', privateRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(privateRow);

        const autoPasteRow = new Adw.SwitchRow({
            title: 'Auto-paste on click or Enter',
            subtitle: 'Paste directly into the previous window (uses Ctrl+Shift+V in terminals)',
        });
        settings.bind('auto-paste', autoPasteRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(autoPasteRow);

        // --- Keyboard Shortcut ---
        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcut',
        });
        page.add(shortcutGroup);

        const shortcutRow = new Adw.ActionRow({
            title: 'Open Smart Clipboard popup',
            subtitle: 'Global keybinding to toggle the history menu',
        });

        const shortcutLabel = new Adw.ShortcutLabel({
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });

        const updateShortcutLabel = () => {
            const list = settings.get_strv('toggle-shortcut');
            shortcutLabel.set_accelerator(list[0] ?? '');
        };
        updateShortcutLabel();
        const shortcutSignalId = settings.connect('changed::toggle-shortcut', updateShortcutLabel);

        const changeShortcutBtn = new Gtk.Button({
            label: 'Change…',
            valign: Gtk.Align.CENTER,
        });
        changeShortcutBtn.connect('clicked', () => {
            this._openShortcutDialog(window, settings);
        });

        shortcutRow.add_suffix(shortcutLabel);
        shortcutRow.add_suffix(changeShortcutBtn);
        shortcutRow.activatable_widget = changeShortcutBtn;
        shortcutGroup.add(shortcutRow);

        // --- Storage & Maintenance ---
        const storageGroup = new Adw.PreferencesGroup({
            title: 'Storage &amp; Cache',
        });
        page.add(storageGroup);

        const storageRow = new Adw.ActionRow({
            title: 'Stored history &amp; image cache',
            subtitle: `${cacheDirPath} (calculating…)`,
        });

        const refreshStats = () => {
            computeDirStatsAsync(cacheDirFile, cancellable)
                .then(({totalBytes, fileCount}) => {
                    storageRow.subtitle = `${cacheDirPath} — ${formatBytes(totalBytes)} (${fileCount} files)`;
                })
                .catch(e => {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        storageRow.subtitle = cacheDirPath;
                });
        };
        refreshStats();

        const wipeBtn = new Gtk.Button({
            label: 'Wipe Cache…',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        wipeBtn.connect('clicked', () => {
            const confirm = new Adw.AlertDialog({
                heading: 'Wipe stored clipboard history?',
                body: 'This permanently deletes all saved text, pinned items, and cached images on disk.',
            });
            confirm.add_response('cancel', 'Cancel');
            confirm.add_response('wipe', 'Wipe All');
            confirm.set_response_appearance('wipe', Adw.ResponseAppearance.DESTRUCTIVE);
            confirm.set_default_response('cancel');
            confirm.set_close_response('cancel');

            confirm.connect('response', (_dlg, response) => {
                if (response !== 'wipe')
                    return;
                settings.set_int64('wipe-nonce', GLib.get_real_time());
                wipeDirContentsAsync(cacheDirFile, cancellable)
                    .then(() => refreshStats())
                    .catch(e => {
                        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            console.warn(`[smart-clipboard] Prefs cache wipe error: ${e.message}`);
                    });
            });
            confirm.present(window);
        });

        storageRow.add_suffix(wipeBtn);
        storageGroup.add(storageRow);

        window.connect('close-request', () => {
            cancellable.cancel();
            settings.disconnect(shortcutSignalId);
            return false;
        });
    }

    _openShortcutDialog(parentWindow, settings) {
        const dialog = new Adw.Dialog({
            title: 'Set Toggle Shortcut',
            content_width: 360,
        });

        const toolbarView = new Adw.ToolbarView();
        toolbarView.add_top_bar(new Adw.HeaderBar());

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 14,
            margin_top: 20,
            margin_bottom: 20,
            margin_start: 20,
            margin_end: 20,
            halign: Gtk.Align.CENTER,
        });

        const hint = new Gtk.Label({
            label: 'Press your new shortcut combination now.\nPress Escape to cancel or Backspace to disable.',
            justify: Gtk.Justification.CENTER,
            wrap: true,
        });

        const current = settings.get_strv('toggle-shortcut')[0] ?? '';
        const preview = new Adw.ShortcutLabel({
            accelerator: current,
            disabled_text: 'Disabled',
            halign: Gtk.Align.CENTER,
        });

        const resetBtn = new Gtk.Button({
            label: 'Reset to Super+V',
            halign: Gtk.Align.CENTER,
        });
        resetBtn.connect('clicked', () => {
            settings.set_strv('toggle-shortcut', [DEFAULT_SHORTCUT]);
            dialog.close();
        });

        box.append(hint);
        box.append(preview);
        box.append(resetBtn);
        toolbarView.set_content(box);
        dialog.set_child(toolbarView);

        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
            if (isModifierKey(keyval))
                return Gdk.EVENT_STOP;

            const mask = state & Gtk.accelerator_get_default_mod_mask();

            if (mask === 0 && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
                settings.set_strv('toggle-shortcut', []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            if (mask === 0 || !Gtk.accelerator_valid(keyval, mask))
                return Gdk.EVENT_STOP;

            const accel = Gtk.accelerator_name(keyval, mask);
            if (accel) {
                settings.set_strv('toggle-shortcut', [accel]);
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(keyController);

        dialog.present(parentWindow);
    }
}
