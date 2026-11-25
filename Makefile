UUID := smart-clipboard@nilaymallik.local
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR := schemas
JS_FILES := extension.js prefs.js clipboardWatcher.js historyStore.js popupUi.js

.PHONY: all compile-schemas install uninstall check test-headless

all: compile-schemas

compile-schemas:
	glib-compile-schemas --strict $(SCHEMA_DIR)

install: compile-schemas
	mkdir -p $(dir $(EXT_DIR))
	@if [ -L "$(EXT_DIR)" ] || [ -e "$(EXT_DIR)" ]; then rm -rf "$(EXT_DIR)"; fi
	ln -s "$(CURDIR)" "$(EXT_DIR)"
	@echo "Installed symlink: $(EXT_DIR) -> $(CURDIR)"

uninstall:
	@if [ -L "$(EXT_DIR)" ]; then rm -f "$(EXT_DIR)"; echo "Removed symlink: $(EXT_DIR)"; else echo "Not installed as symlink: $(EXT_DIR)"; fi

check: compile-schemas
	@for f in $(JS_FILES); do \
		node --check "$$f" || exit 1; \
	done
	gjs -m tests/store.test.mjs
	@echo "Syntax, schema, and store checks passed."

test-headless: install
	@echo "Running isolated headless GNOME Shell 51 enable/disable/re-enable test..."
	@bash -euo pipefail -c ' \
		TMPDIR=$$(mktemp -d /tmp/smart-clipboard-test-XXXXXX); \
		trap "rm -rf \"$$TMPDIR\"" EXIT; \
		dbus-run-session -- bash -c " \
			export XDG_CACHE_HOME=\"$$TMPDIR/cache\" GSETTINGS_BACKEND=memory; \
			mkdir -p \"\$$XDG_CACHE_HOME\"; \
			gnome-shell --headless --wayland --virtual-monitor 1280x720 >\"$$TMPDIR/shell.log\" 2>&1 & \
			PID=\$$!; \
			for i in \$$(seq 1 30); do gnome-extensions list >/dev/null 2>&1 && break; sleep 0.3; done; \
			gnome-extensions enable $(UUID); \
			sleep 1; \
			gnome-extensions info $(UUID) | grep -q \"State: ACTIVE\"; \
			gnome-extensions disable $(UUID); \
			sleep 0.5; \
			gnome-extensions enable $(UUID); \
			sleep 1; \
			gnome-extensions info $(UUID) | grep -q \"State: ACTIVE\"; \
			kill \$$PID 2>/dev/null || true; \
			wait \$$PID 2>/dev/null || true; \
		"; \
		if grep -iE "$(UUID)|smart-clipboard" "$$TMPDIR/shell.log" | grep -iE "ERROR|CRITICAL|Exception|Warning"; then \
			cat "$$TMPDIR/shell.log"; \
			echo "FAILED: Errors found for $(UUID)"; exit 1; \
		fi; \
		echo "PASSED: $(UUID) loaded, enabled, disabled, and re-enabled with zero errors in GNOME Shell 51."; \
	'
