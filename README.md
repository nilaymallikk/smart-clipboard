# Smart Clipboard

Simple, one-click clipboard history for GNOME Shell 51 — click the panel icon or press **Super+V** to see big vertical previews of your top 3 items, copy or pin in one click, and drag items straight into any app.

## Features

- **One-click clipboard**: click the top-bar icon or press **Super+V**, click any item to copy & paste it immediately
- **Top 3 big vertical previews**: the 3 most recent/pinned items show large image previews, multi-line text previews, or color swatches right away; older items scroll compactly below
- **Simple actions on every card**: **Copy**, **Pin**, **Full Preview** (lightbox for full-size images or long text), and **Delete** (with 5-second **Undo** toast)
- **Easy drag-and-drop**: drag any card straight into browsers, Slack, Discord, Files, GIMP, or editors; drag pinned items to reorder
- **Fast search**: type to filter across text, images, and source app name
- **Privacy**: skips password managers automatically, plus one-click Private Mode and Clear Unpinned

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Super+V` | Open / close clipboard (configurable) |
| Click / `Enter` | Copy & auto-paste into previous app |
| `Up` / `Down` | Move selection |
| `Ctrl+P` | Pin / unpin selected item |
| `Delete` | Delete selected item |
| `Ctrl+Z` | Undo last delete |
| `Escape` | Clear search or close |

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
