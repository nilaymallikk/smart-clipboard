# Smart Clipboard

Simple, one-click clipboard bar for GNOME Shell 51 — click the top-bar icon or press **Super+V** to open a sleek top-right floating overlay with 3 big preview tiles, a **Text** filter tile, and an expandable **`>`** full history drawer.

## Features

- **Sleek floating 3-tile preview bar**: opens right under the top-right panel with 3 large preview tiles (images, code/text, color swatches) + a right-side **`T` Text** filter tile
- **One-click copy & paste**: single-click any tile (or press `1`–`3` / `Enter`) to copy, close, and auto-paste into your previous app (`Ctrl+V`, or `Ctrl+Shift+V` in terminals)
- **Hover actions on every tile**: **Copy** (without closing), **Pin**, **Full Preview** (lightbox for full-res images or long text), and **Delete** (with 5-second **Undo** toast)
- **Easy drag-and-drop**: drag any tile or history row straight into browsers, Slack, Discord, Files, GIMP, or editors; drag pinned items to reorder
- **Expandable history (`>`)**: click `>` (or press `Down`) to reveal search, older history items, Private Mode, Clear Unpinned, and Preferences
- **Privacy**: skips password managers automatically, plus Private Mode

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Super+V` | Open / close clipboard (configurable) |
| Click / `Enter` / `1`–`3` | Copy & auto-paste tile |
| `Left` / `Right` | Move selection across the 3 preview tiles |
| `Down` | Expand full history & search drawer |
| `Space` | Open full-size preview for selected tile |
| `Ctrl+P` | Pin / unpin selected item |
| `Delete` | Delete selected item |
| `Ctrl+Z` | Undo last delete |
| `Escape` | Clear search, collapse drawer, or close |

## Install

```bash
make install      # compiles schemas and symlinks into ~/.local/share/gnome-shell/extensions
```

Log out and back in on Wayland, then enable:

```bash
gnome-extensions enable smart-clipboard@nilaymallik.local
```

Left-click the top-bar icon to toggle the clipboard; right-click for quick actions (Private Mode, Auto-Paste, Clear Unpinned, Preferences). Remove with `make uninstall`.

## Develop & Test

```bash
make check         # compile schemas + syntax checks + store & client tests
make test-headless # isolated headless GNOME Shell 51 enable/disable test
```

## Settings

| Key | Default | Meaning |
|-----|---------|---------|
| `toggle-shortcut` | `<Super>v` | Global toggle |
| `max-text-history` | `50` | Unpinned text entries kept |
| `max-image-history` | `20` | Unpinned image entries kept |
| `max-image-size-mb` | `10` | Largest image stored |
| `capture-images` | `true` | Record copied images |
| `persist-history` | `true` | Save history across sessions |
| `private-mode` | `false` | Pause recording |
| `auto-paste` | `true` | Auto-paste on click / Enter (`Ctrl+Shift+V` in terminals) |

## Layout

| File | Purpose |
|------|---------|
| `extension.js` | Extension lifecycle, shortcut, auto-paste, popup launcher |
| `clipboardWatcher.js` | Clipboard monitoring & password-manager filtering |
| `historyStore.js` | Storage, dedupe, pin order, undo, search scoring |
| `dbusService.js` | Session D-Bus bridge between extension and GTK4 popup |
| `popupUi.js` | Top-bar panel indicator & right-click quick menu |
| `popupApp.js` | Single-column GTK4/Libadwaita popup with top-3 vertical previews & DnD |
| `popupClient.js` | D-Bus client, filtering, formatting, drag ContentProvider builder |
| `popup.css` | Popup styling |
| `prefs.js` | GNOME Preferences window |
| `schemas/` | GSettings schema |
| `tests/` | Unit tests |
