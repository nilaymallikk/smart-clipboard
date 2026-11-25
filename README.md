# Smart Clipboard

Fast, keyboard-first clipboard manager for GNOME Shell 51 with a native GTK4/Libadwaita floating popup, live text & image previews, pin/copy actions, auto-paste, and real Wayland drag-and-drop into any app.

## Features

- **Live Split Preview Pane** (toggleable with `Ctrl+\` or the Preview button):
  - **Images**: full-size scaled preview, dimensions, size, source app, **Save As…**, **Open**, and direct drag-and-drop straight from the preview
  - **Text / Code / JSON / URLs**: full scrollable viewer, **inline Edit & Save** (`Ctrl+E`), one-click **Open Link**, and quick copy transforms (**Format JSON**, **1-Line**, **Trim**, **UPPER**, **lower**)
  - **Colors**: automatic `#hex` / `rgb()` / `hsl()` detection with live color swatch in both the list and preview
- **Explicit Copy, Pin, Preview & Delete Actions**:
  - **Copy** button (or `Ctrl+C`) copies to clipboard with a toast without closing the popup
  - **Paste** (`Enter` or double-click) restores focus to your previous window and pastes automatically (`Ctrl+V`, or `Ctrl+Shift+V` in terminals)
  - **Pin / Unpin** (`Ctrl+P`) pins items to the top, exempts them from pruning & Clear Unpinned, and lets you **drag pinned items to reorder**
  - **Undo Delete** (`Ctrl+Z` or toast button) restores accidentally deleted items—including images
- **True Wayland Drag-and-Drop**:
  - Drag any row or preview straight into browsers, Slack, Discord, Files, GIMP, VS Code, or LibreOffice
  - Images export `GdkFileList`, `text/uri-list`, and raw image MIME bytes; URLs export `text/uri-list` + `text/plain`
  - **Keep Open** pin button docks the popup above other windows while you drag multiple items
- **Smart Organization & Search**:
  - Instant fuzzy/substring search across text, metadata, and **source app** (e.g. `firefox`, `code`)
  - Category filter pills: `All`, `Pinned`, `Text`, `Images`, `Links`, `Code`, `Colors` (`Ctrl+1..7`)
  - Instant number paste (`Alt+1`–`Alt+9`) for the top 9 visible items
- **Privacy & Persistence**:
  - Skips password manager entries (`x-kde-passwordManagerHint`, KeePassXC, Bitwarden, GNOME Password)
  - One-click **Private Mode** to pause recording, optional disk persistence, and cache wipe in Preferences

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Super+V` | Toggle Smart Clipboard (configurable) |
| `Enter` / Double-click | Paste into previous app (or copy & close) |
| `Shift+Enter` | Paste clean single-line text |
| `Ctrl+C` | Copy without closing |
| `Ctrl+P` | Pin / unpin selected item |
| `Ctrl+E` | Edit selected text inline (`Ctrl+Enter` / `Ctrl+S` to save) |
| `Ctrl+\` | Toggle live preview pane |
| `Alt+1`–`Alt+9` | Instant paste visible item #1–9 |
| `Ctrl+1`–`Ctrl+7` | Switch category filter |
| `Delete` | Delete selected item |
| `Ctrl+Z` | Undo last delete / clear |
| `Escape` | Cancel edit, clear search, or close |

## Install

```bash
make install      # compiles schemas and symlinks into ~/.local/share/gnome-shell/extensions
```

Then log out and back in on Wayland and enable it:

```bash
gnome-extensions enable smart-clipboard@nilaymallik.local
```

Left-click the top-bar icon to toggle the popup; right-click for quick actions (Private Mode, Auto-Paste, Clear Unpinned, Preferences). Remove with `make uninstall`.

## Develop & Test

```bash
make check         # compile schemas + syntax checks + store & client unit tests
make test-headless # isolated headless GNOME Shell 51 enable/disable/re-enable test
```

## Settings

| Key | Default | Meaning |
|-----|---------|---------|
| `toggle-shortcut` | `<Super>v` | Global toggle keybinding |
| `max-text-history` | `50` | Unpinned text entries kept |
| `max-image-history` | `20` | Unpinned image entries kept |
| `max-image-size-mb` | `10` | Largest image stored |
| `capture-images` | `true` | Record copied images |
| `persist-history` | `true` | Save history across sessions |
| `private-mode` | `false` | Pause recording |
| `auto-paste` | `true` | Auto-paste on Enter / double-click |
| `show-preview-pane` | `true` | Show live preview pane |

## Layout

| File | Purpose |
|------|---------|
| `extension.js` | Extension lifecycle, shortcut, focus/auto-paste, popup launcher |
| `clipboardWatcher.js` | Clipboard monitoring & password-manager filtering |
| `historyStore.js` | Storage, dedupe, classification, pin order, undo, search scoring |
| `dbusService.js` | Session D-Bus bridge between extension and GTK4 popup |
| `popupUi.js` | Top-bar panel indicator & right-click quick menu |
| `popupApp.js` | Native GTK4/Libadwaita floating popup with drag-and-drop |
| `popupPreview.js` | Live split preview pane (image, color, text/code, inline editor) |
| `popupClient.js` | D-Bus client, filters, transforms, and drag ContentProvider builder |
| `popup.css` | Libadwaita-aware popup stylesheet |
| `prefs.js` | GNOME Settings / Preferences window |
| `schemas/` | GSettings schema |
| `tests/` | Unit tests for store and popup client |
