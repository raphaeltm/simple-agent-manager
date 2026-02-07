# VM Agent Makefile

.PHONY: all build build-ui embed clean test lint

# Go build settings
BINARY_NAME := vm-agent
GO := go
GOFLAGS := -ldflags="-s -w"

# Platforms
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64

# Default target
all: build

# Build UI first, then Go binary
build: build-ui embed
	$(GO) build $(GOFLAGS) -o bin/$(BINARY_NAME) .

# Build the embedded React UI
build-ui:
	cd ui && pnpm build

# Copy built UI to static directory for embedding
embed:
	rm -rf internal/server/static
	mkdir -p internal/server/static
	cp -r ui/dist/* internal/server/static/

# Build for all platforms
build-all: build-ui embed
	@for platform in $(PLATFORMS); do \
		GOOS=$$(echo $$platform | cut -d/ -f1); \
		GOARCH=$$(echo $$platform | cut -d/ -f2); \
		echo "Building: bin/$(BINARY_NAME)-$$GOOS-$$GOARCH"; \
		GOOS=$$GOOS GOARCH=$$GOARCH $(GO) build $(GOFLAGS) -o bin/$(BINARY_NAME)-$$GOOS-$$GOARCH . || exit 1; \
		echo "Built: bin/$(BINARY_NAME)-$$GOOS-$$GOARCH"; \
	done

# Build for Linux AMD64 (most common for VMs)
build-linux-amd64: build-ui embed
	GOOS=linux GOARCH=amd64 $(GO) build $(GOFLAGS) -o bin/$(BINARY_NAME)-linux-amd64 .

# Build for Linux ARM64
build-linux-arm64: build-ui embed
	GOOS=linux GOARCH=arm64 $(GO) build $(GOFLAGS) -o bin/$(BINARY_NAME)-linux-arm64 .

# Run tests
test:
	$(GO) test -v ./...

# Run linter
lint:
	golangci-lint run

# Clean build artifacts
clean:
	rm -rf bin/
	rm -rf internal/server/static
	rm -rf ui/dist
	rm -rf ui/node_modules

# Development: run locally
dev: build
	./bin/$(BINARY_NAME)

# Development: watch and rebuild UI
dev-ui:
	cd ui && pnpm dev

# Generate version info
version:
	@echo '{"version": "$(shell git describe --tags --always --dirty)", "buildDate": "$(shell date -u +%Y-%m-%dT%H:%M:%SZ)"}' > version.json

# Install dependencies
deps:
	$(GO) mod download
