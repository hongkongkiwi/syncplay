# macOS compatibility: if gmake exists, use it; otherwise fall back to make
GMAKE := $(shell command -v gmake 2>/dev/null || echo make)

all:
	@$(GMAKE)

.DEFAULT:
	@$(GMAKE) $@
