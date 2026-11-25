UUID := smart-clipboard@nilaymallik.local
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR := schemas
JS_FILES := extension.js prefs.js clipboardWatcher.js historyStore.js dbusService.js popupUi.js popupClient.js popupApp.js

.PHONY: all compile-schemas install uninstall check test-headless test-image-capture

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
	gjs -m tests/client.test.mjs
	@echo "Syntax, schema, store, and client checks passed."

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

test-image-capture: install
	@echo "Running headless GNOME Shell 51 raw-image capture + GC + auto-paste regression test..."
	@bash -euo pipefail -c ' \
		TMPDIR=$$(mktemp -d /tmp/smart-clipboard-img-XXXXXX); \
		trap "rm -rf \"$$TMPDIR\"" EXIT; \
		mkdir -p "$$TMPDIR/runtime" "$$TMPDIR/cache"; \
		chmod 700 "$$TMPDIR/runtime"; \
		dbus-run-session -- bash -euo pipefail -c " \
			export XDG_RUNTIME_DIR=\"$$TMPDIR/runtime\" XDG_CACHE_HOME=\"$$TMPDIR/cache\" GSETTINGS_BACKEND=memory MALLOC_PERTURB_=170; \
			gnome-shell --headless --wayland --unsafe-mode --virtual-monitor 1280x720 >\"$$TMPDIR/shell.log\" 2>&1 & \
			PID=\$$!; \
			for i in \$$(seq 1 40); do gnome-extensions list >/dev/null 2>&1 && break; sleep 0.3; done; \
			gnome-extensions enable $(UUID); \
			sleep 1; \
			for idx in 1 2 3 4; do \
				gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval \
					\"(function(){ const St=imports.gi.St, GLib=imports.gi.GLib, GdkPixbuf=imports.gi.GdkPixbuf; const pb=GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,true,8,320+\$$idx*20,240); pb.fill((0x3584e4ff+\$$idx*0x10101000)>>>0); const [,buf]=pb.save_to_bufferv(\\\"png\\\",[],[]); St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD,\\\"image/png\\\",new GLib.Bytes(buf)); return \\\"ok\\\"; })()\" >/dev/null; \
				sleep 0.15; \
				gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval \"imports.system.gc(); 1\" >/dev/null; \
				sleep 0.25; \
			done; \
			STATE=\$$(gdbus call --session --dest org.gnome.Shell.Extensions.SmartClipboard --object-path /org/gnome/Shell/Extensions/SmartClipboard --method org.gnome.Shell.Extensions.SmartClipboard.GetState); \
			COUNT=\$$(echo \"\$$STATE\" | grep -o \"\\\"type\\\":\\\"image\\\"\" | wc -l); \
			test \"\$$COUNT\" -eq 4 || { echo \"FAILED: expected 4 captured images, got \$$COUNT\"; exit 1; }; \
			FIRST_ID=\$$(echo \"\$$STATE\" | grep -oE \"\\\"id\\\":\\\"[^\\\"]+\\\"\" | head -n1 | cut -d\\\" -f4); \
			gdbus call --session --dest org.gnome.Shell.Extensions.SmartClipboard --object-path /org/gnome/Shell/Extensions/SmartClipboard --method org.gnome.Shell.Extensions.SmartClipboard.CopyEntry \"\$$FIRST_ID\" true >/dev/null; \
			sleep 0.3; \
			gnome-extensions disable $(UUID); \
			sleep 0.4; \
			kill \$$PID 2>/dev/null || true; \
			wait \$$PID 2>/dev/null || true; \
		"; \
		if grep -iE "g_atomic_ref_count|double free|cannot be safely stored|get_default_backend|vfunc_event" "$$TMPDIR/shell.log"; then \
			echo "FAILED: Crash/corruption/API warning found in shell.log"; exit 1; \
		fi; \
		if grep -iE "$(UUID)|smart-clipboard" "$$TMPDIR/shell.log" | grep -iE "ERROR|CRITICAL|Exception|Warning"; then \
			cat "$$TMPDIR/shell.log"; \
			echo "FAILED: Extension errors found"; exit 1; \
		fi; \
		echo "PASSED: 4 raw PNG images captured under MALLOC_PERTURB_=170 + GC + auto-paste with zero errors."; \
	'
