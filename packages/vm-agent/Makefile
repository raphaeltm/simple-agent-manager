# VM Agent Makefile

.PHONY: all build clean test test-integration lint prepare-container

# Go build settings
BINARY_NAME := vm-agent
GO := go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
GO_VERSION ?= $(shell $(GO) version 2>/dev/null | awk '{print $$3}' || echo "unknown")
LDFLAGS_VERSION := -X github.com/workspace/vm-agent/internal/sysinfo.Version=$(VERSION) -X github.com/workspace/vm-agent/internal/sysinfo.BuildDate=$(BUILD_DATE) -X github.com/workspace/vm-agent/internal/sysinfo.GoVersionBuild=$(GO_VERSION)
GOFLAGS := -ldflags="-s -w $(LDFLAGS_VERSION)"
CONTAINER_ARTIFACT_DIR ?= ../../apps/api/container-artifacts

# Platforms
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64

# Default target
all: build

# Build Go binary
build:
	$(GO) build $(GOFLAGS) -o bin/$(BINARY_NAME) .

# Build for all platforms
build-all:
	@for platform in $(PLATFORMS); do \
		GOOS=$$(echo $$platform | cut -d/ -f1); \
		GOARCH=$$(echo $$platform | cut -d/ -f2); \
		echo "Building: bin/$(BINARY_NAME)-$$GOOS-$$GOARCH"; \
		GOOS=$$GOOS GOARCH=$$GOARCH $(GO) build $(GOFLAGS) -o bin/$(BINARY_NAME)-$$GOOS-$$GOARCH . || exit 1; \
		echo "Built: bin/$(BINARY_NAME)-$$GOOS-$$GOARCH"; \
	done

# Build for Linux AMD64 (most common for VMs)
build-linux-amd64:
	GOOS=linux GOARCH=amd64 $(GO) build $(GOFLAGS) -o bin/$(BINARY_NAME)-linux-amd64 .

# Build the exact binary Wrangler bakes into the raw Cloudflare Container image.
# VERSION/BUILD_DATE default locally and are pinned by deploy-reusable.yml.
prepare-container: build-linux-amd64
	@mkdir -p $(CONTAINER_ARTIFACT_DIR)
	@cp bin/$(BINARY_NAME)-linux-amd64 $(CONTAINER_ARTIFACT_DIR)/vm-agent-linux-amd64
	@chmod 0755 $(CONTAINER_ARTIFACT_DIR)/vm-agent-linux-amd64
	@if command -v sha256sum >/dev/null 2>&1; then \
		SHA256=$$(sha256sum $(CONTAINER_ARTIFACT_DIR)/vm-agent-linux-amd64 | cut -d' ' -f1); \
	elif command -v shasum >/dev/null 2>&1; then \
		SHA256=$$(shasum -a 256 $(CONTAINER_ARTIFACT_DIR)/vm-agent-linux-amd64 | cut -d' ' -f1); \
	else \
		echo "ERROR: neither sha256sum nor shasum is available" >&2; exit 1; \
	fi; \
		printf '{"version":"%s","buildDate":"%s","sha256":"sha256:%s"}\n' \
		  '$(VERSION)' '$(BUILD_DATE)' "$$SHA256" > $(CONTAINER_ARTIFACT_DIR)/vm-agent-version.json

# Build for Linux ARM64
build-linux-arm64:
	GOOS=linux GOARCH=arm64 $(GO) build $(GOFLAGS) -o bin/$(BINARY_NAME)-linux-arm64 .

# Run tests
test:
	$(GO) test -race -v ./...

# Run integration tests (requires Docker and optionally devcontainer CLI)
test-integration:
	$(GO) test -v -tags integration -timeout 10m ./internal/bootstrap/

# Run linter
lint:
	golangci-lint run

# Clean build artifacts
clean:
	rm -rf bin/

# Development: run locally
dev: build
	./bin/$(BINARY_NAME)

# Generate version info
version:
	@echo '{"version": "$(shell git describe --tags --always --dirty)", "buildDate": "$(shell date -u +%Y-%m-%dT%H:%M:%SZ)"}' > version.json

# Install dependencies
deps:
	$(GO) mod download
