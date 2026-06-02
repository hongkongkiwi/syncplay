# Syncplay P2P — Rust build targets
# Primary workflow: use 'just' (see justfile).
# This Makefile exists for CI and muscle-memory compatibility.
# All old Python targets (syncplayClient.py, syncplayServer.py) removed.

CARGO = cargo
MANIFEST = p2p/rust/Cargo.toml
FEATURES = --features tui

.PHONY: all build release check test clippy fmt clean signaling tui turn

all: build

build:
	$(CARGO) build $(FEATURES) --manifest-path $(MANIFEST)

release:
	$(CARGO) build $(FEATURES) --release --manifest-path $(MANIFEST)

check:
	$(CARGO) check $(FEATURES) --manifest-path $(MANIFEST)

test:
	$(CARGO) test --lib --manifest-path $(MANIFEST)

clippy:
	$(CARGO) clippy $(FEATURES) --all-targets --manifest-path $(MANIFEST) -- -D warnings

fmt:
	$(CARGO) fmt --manifest-path $(MANIFEST) -- --check

clean:
	$(CARGO) clean --manifest-path $(MANIFEST)

signaling:
	$(CARGO) run --bin syncplay-signaling --manifest-path $(MANIFEST)

tui:
	$(CARGO) run --bin syncplay-tui $(FEATURES) --manifest-path $(MANIFEST)

turn:
	$(CARGO) run --bin syncplay-turn --manifest-path $(MANIFEST)

# Legacy target stubs — print migration notice (non-fatal)
install-client install-server install uninstall-client uninstall-server uninstall:
	@echo "Syncplay is now a pure Rust project. Use 'make build' or 'just build'."
	@echo "Binaries: target/release/syncplay-signaling  +  target/release/syncplay-tui  +  target/release/syncplay-turn"
