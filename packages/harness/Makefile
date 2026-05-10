# SAM Harness Makefile

.PHONY: all build build-all build-linux-amd64 build-linux-arm64 test clean

BINARY_NAME := sam-harness
GO := go
GOFLAGS := -trimpath -ldflags="-s -w"

PLATFORMS := linux/amd64 linux/arm64

all: build

build:
	CGO_ENABLED=0 $(GO) build $(GOFLAGS) -o bin/$(BINARY_NAME) ./cmd/harness/

build-all:
	@for platform in $(PLATFORMS); do \
		GOOS=$$(echo $$platform | cut -d/ -f1); \
		GOARCH=$$(echo $$platform | cut -d/ -f2); \
		echo "Building: bin/$(BINARY_NAME)-$$GOOS-$$GOARCH"; \
		CGO_ENABLED=0 GOOS=$$GOOS GOARCH=$$GOARCH $(GO) build $(GOFLAGS) -o bin/$(BINARY_NAME)-$$GOOS-$$GOARCH ./cmd/harness/ || exit 1; \
		echo "Built: bin/$(BINARY_NAME)-$$GOOS-$$GOARCH"; \
	done

build-linux-amd64:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build $(GOFLAGS) -o bin/$(BINARY_NAME)-linux-amd64 ./cmd/harness/

build-linux-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GO) build $(GOFLAGS) -o bin/$(BINARY_NAME)-linux-arm64 ./cmd/harness/

test:
	$(GO) test ./...

clean:
	rm -rf bin/
