import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const SERVICE_BUS_NAME = 'org.gnome.Shell.Extensions.SmartClipboard';
export const SERVICE_OBJECT_PATH = '/org/gnome/Shell/Extensions/SmartClipboard';
export const SERVICE_IFACE_NAME = 'org.gnome.Shell.Extensions.SmartClipboard';

export const POPUP_APP_ID = 'org.gnome.Shell.Extensions.SmartClipboard.Popup';
export const POPUP_OBJECT_PATH = '/org/gnome/Shell/Extensions/SmartClipboard/Popup';
export const POPUP_IFACE_NAME = 'org.gnome.Shell.Extensions.SmartClipboard.Popup';

export const SERVICE_IFACE_XML = `
<node>
  <interface name="${SERVICE_IFACE_NAME}">
    <method name="GetState">
      <arg type="s" direction="out" name="stateJson"/>
    </method>
    <method name="CopyEntry">
      <arg type="s" direction="in" name="id"/>
      <arg type="b" direction="in" name="paste"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="CopyText">
      <arg type="s" direction="in" name="text"/>
      <arg type="b" direction="in" name="paste"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="TogglePin">
      <arg type="s" direction="in" name="id"/>
      <arg type="b" direction="out" name="pinned"/>
    </method>
    <method name="ReorderPinned">
      <arg type="s" direction="in" name="sourceId"/>
      <arg type="s" direction="in" name="targetId"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="UpdateText">
      <arg type="s" direction="in" name="id"/>
      <arg type="s" direction="in" name="newText"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="DeleteEntry">
      <arg type="s" direction="in" name="id"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="ClearUnpinned">
      <arg type="u" direction="out" name="removedCount"/>
    </method>
    <method name="UndoDelete">
      <arg type="u" direction="out" name="restoredCount"/>
    </method>
    <method name="SetPaused">
      <arg type="b" direction="in" name="paused"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="SetShowPreview">
      <arg type="b" direction="in" name="show"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="SetKeepOpen">
      <arg type="b" direction="in" name="keepOpen"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="OpenPreferences">
      <arg type="b" direction="out" name="ok"/>
    </method>
    <signal name="Changed"/>
  </interface>
</node>`;

export const POPUP_IFACE_XML = `
<node>
  <interface name="${POPUP_IFACE_NAME}">
    <method name="Toggle"/>
    <method name="Show"/>
    <method name="Hide"/>
    <method name="Quit"/>
  </interface>
</node>`;

export class ClipboardDBusService {
    #dbusImpl = null;
    #ownerId = 0;
    #handlers = null;
    #destroyed = false;

    constructor(handlers) {
        this.#handlers = handlers;
        this.#dbusImpl = Gio.DBusExportedObject.wrapJSObject(SERVICE_IFACE_XML, this);
        this.#dbusImpl.export(Gio.DBus.session, SERVICE_OBJECT_PATH);
        this.#ownerId = Gio.bus_own_name_on_connection(
            Gio.DBus.session,
            SERVICE_BUS_NAME,
            Gio.BusNameOwnerFlags.REPLACE | Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT,
            null,
            null
        );
    }

    emitChanged() {
        if (this.#destroyed || !this.#dbusImpl)
            return;
        try {
            this.#dbusImpl.emit_signal('Changed', null);
        } catch (e) {
            console.warn(`[smart-clipboard] D-Bus emitChanged failed: ${e.message}`);
        }
    }

    GetState() {
        try {
            return JSON.stringify(this.#handlers?.getState?.() ?? {});
        } catch (e) {
            console.warn(`[smart-clipboard] GetState error: ${e.message}`);
            return '{}';
        }
    }

    CopyEntryAsync(params, invocation) {
        const [id, paste] = params;
        Promise.resolve(this.#handlers?.copyEntry?.(id, paste))
            .then(ok => {
                invocation.return_value(new GLib.Variant('(b)', [Boolean(ok)]));
            })
            .catch(e => {
                console.warn(`[smart-clipboard] CopyEntry error: ${e.message}`);
                invocation.return_value(new GLib.Variant('(b)', [false]));
            });
    }

    CopyTextAsync(params, invocation) {
        const [text, paste] = params;
        Promise.resolve(this.#handlers?.copyText?.(text, paste))
            .then(ok => {
                invocation.return_value(new GLib.Variant('(b)', [Boolean(ok)]));
            })
            .catch(e => {
                console.warn(`[smart-clipboard] CopyText error: ${e.message}`);
                invocation.return_value(new GLib.Variant('(b)', [false]));
            });
    }

    TogglePin(id) {
        return Boolean(this.#handlers?.togglePin?.(id));
    }

    ReorderPinned(sourceId, targetId) {
        return Boolean(this.#handlers?.reorderPinned?.(sourceId, targetId));
    }

    UpdateText(id, newText) {
        return Boolean(this.#handlers?.updateText?.(id, newText));
    }

    DeleteEntry(id) {
        return Boolean(this.#handlers?.deleteEntry?.(id));
    }

    ClearUnpinned() {
        return Number(this.#handlers?.clearUnpinned?.() ?? 0) >>> 0;
    }

    UndoDelete() {
        return Number(this.#handlers?.undoDelete?.() ?? 0) >>> 0;
    }

    SetPaused(paused) {
        this.#handlers?.setPaused?.(Boolean(paused));
        return true;
    }

    SetShowPreview(show) {
        this.#handlers?.setShowPreview?.(Boolean(show));
        return true;
    }

    SetKeepOpen(keepOpen) {
        this.#handlers?.setKeepOpen?.(Boolean(keepOpen));
        return true;
    }

    OpenPreferences() {
        this.#handlers?.openPreferences?.();
        return true;
    }

    destroy() {
        this.#destroyed = true;
        if (this.#ownerId !== 0) {
            Gio.bus_unown_name(this.#ownerId);
            this.#ownerId = 0;
        }
        if (this.#dbusImpl) {
            try {
                this.#dbusImpl.unexport();
            } catch {
                // ignore
            }
            this.#dbusImpl = null;
        }
        this.#handlers = null;
    }
}
