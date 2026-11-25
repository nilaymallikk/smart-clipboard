# Smart Clipboard

Fast, lightweight, keyboard-first clipboard history for GNOME Shell 51 — text and images, no daemon, no dependencies.

## Features

- Global shortcut (**Super+V** by default) opens a searchable clipboard history
- Remembers text and image entries (configurable limits and max image size)
- Fuzzy/substring search filter as you type
- Keyboard-first: arrows to move, Enter to copy, Esc to close
- Optional persistence across sessions
- Private mode to pause recording, plus a wipe action
- Native GNOME preferences window

## Install

```bash
make install      # symlinks the extension into ~/.local/share/gnome-shell/extensions
```

Then restart GNOME Shell (log out and back in on Wayland) and enable it:

```bash
gnome-extensions enable smart-clipboard@nilaymallik.local
```

Remove with `make uninstall`.

## Develop

```bash
make check         # compile schemas + syntax check + store unit tests
make test-headless # isolated headless GNOME Shell enable/disable test
```

## Settings

| Key | Default | Meaning |
|-----|---------|---------|
| `toggle-shortcut` | `<Super>v` | Global toggle |
| `max-text-history` | 50 | Text entries kept |
| `max-image-history` | 20 | Image entries kept |
| `max-image-size-mb` | 10 | Largest image stored |
| `capture-images` | true | Record images at all |
| `persist-history` | true | Save history to disk |
| `private-mode` | false | Pause recording |

## Layout

| File | Purpose |
|------|---------|
| `extension.js` | Extension entry point, indicator and shortcut |
| `clipboardWatcher.js` | Clipboard polling |
| `historyStore.js` | History model, dedupe, search scoring |
| `popupUi.js` | Popup menu UI |
| `prefs.js` | Preferences window |
| `schemas/` | GSettings schema |
| `tests/` | Headless tests |
