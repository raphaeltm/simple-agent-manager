# SAM CLI Makefile

.PHONY: all build build-all clean test version

BINARY_NAME := sam
GO := go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64

all: build

build:
	@mkdir -p bin
	$(GO) build -o bin/$(BINARY_NAME) ./cmd/sam

build-all:
	@mkdir -p bin
	@for platform in $(PLATFORMS); do \
		GOOS=$$(echo $$platform | cut -d/ -f1); \
		GOARCH=$$(echo $$platform | cut -d/ -f2); \
		echo "Building: bin/$(BINARY_NAME)-$$GOOS-$$GOARCH"; \
		GOOS=$$GOOS GOARCH=$$GOARCH $(GO) build -o bin/$(BINARY_NAME)-$$GOOS-$$GOARCH ./cmd/sam || exit 1; \
		echo "Built: bin/$(BINARY_NAME)-$$GOOS-$$GOARCH"; \
	done

test:
	$(GO) test -race -coverprofile=coverage.out -covermode=atomic ./...

version:
	@mkdir -p bin
	@printf '{"version":"%s","buildDate":"%s"}\n' "$(VERSION)" "$(BUILD_DATE)" > bin/version.json

clean:
	rm -rf bin/
