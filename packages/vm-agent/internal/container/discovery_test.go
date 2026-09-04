package container

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestGetContainerIDRediscoveresStaleCachedContainer(t *testing.T) {
	restore := stubDockerDiscovery(
		func(context.Context, string, string) ([]containerCandidate, error) {
			return []containerCandidate{{id: "fresh", createdAt: time.Now()}}, nil
		},
		func(_ context.Context, id string) bool {
			return id != "stale"
		},
		func(string) (string, error) {
			return "172.17.0.2", nil
		},
	)
	defer restore()

	discovery := NewDiscovery(Config{CacheTTL: time.Minute})
	discovery.containerID = "stale"
	discovery.lastCheck = time.Now()
	discovery.bridgeIP = "172.17.0.99"
	discovery.bridgeIPForID = "stale"
	discovery.bridgeIPCheck = time.Now()

	id, err := discovery.GetContainerID()
	if err != nil {
		t.Fatalf("GetContainerID failed: %v", err)
	}
	if id != "fresh" {
		t.Fatalf("expected fresh container, got %q", id)
	}
	if discovery.bridgeIP != "" || discovery.bridgeIPForID != "" {
		t.Fatal("expected stale bridge IP cache to be cleared")
	}
}

func TestGetContainerIDSelectsNewestMatchingContainer(t *testing.T) {
	older := time.Date(2026, 5, 12, 10, 0, 0, 0, time.UTC)
	newer := older.Add(time.Minute)
	restore := stubDockerDiscovery(
		func(context.Context, string, string) ([]containerCandidate, error) {
			return []containerCandidate{
				{id: "older", createdAt: older},
				{id: "newer", createdAt: newer},
			}, nil
		},
		func(context.Context, string) bool { return true },
		func(string) (string, error) { return "172.17.0.2", nil },
	)
	defer restore()

	discovery := NewDiscovery(Config{})
	id, err := discovery.GetContainerID()
	if err != nil {
		t.Fatalf("GetContainerID failed: %v", err)
	}
	if id != "newer" {
		t.Fatalf("expected newest container, got %q", id)
	}
}

func TestFindContainerByLabelSortsCandidates(t *testing.T) {
	createdAt := time.Date(2026, 5, 16, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name       string
		candidates []containerCandidate
		want       string
	}{
		{
			name: "same timestamp selects lower ID",
			candidates: []containerCandidate{
				{id: "bbb", createdAt: createdAt},
				{id: "aaa", createdAt: createdAt},
			},
			want: "aaa",
		},
		{
			name: "different timestamps selects newest",
			candidates: []containerCandidate{
				{id: "newer", createdAt: createdAt.Add(time.Minute)},
				{id: "older", createdAt: createdAt},
			},
			want: "newer",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			restore := stubDockerDiscovery(
				func(_ context.Context, labelKey, labelValue string) ([]containerCandidate, error) {
					if labelKey != "devcontainer.local_folder" || labelValue != "/workspace" {
						t.Fatalf("unexpected label %s=%s", labelKey, labelValue)
					}
					return tt.candidates, nil
				},
				func(context.Context, string) bool { return true },
				func(string) (string, error) { return "172.17.0.2", nil },
			)
			defer restore()

			id, err := FindContainerByLabel(context.Background(), "devcontainer.local_folder", "/workspace")
			if err != nil {
				t.Fatalf("FindContainerByLabel failed: %v", err)
			}
			if id != tt.want {
				t.Fatalf("expected %q, got %q", tt.want, id)
			}
		})
	}
}

func TestFindContainerByLabelReturnsErrorWhenNoCandidates(t *testing.T) {
	restore := stubDockerDiscovery(
		func(context.Context, string, string) ([]containerCandidate, error) {
			return nil, nil
		},
		func(context.Context, string) bool { return true },
		func(string) (string, error) { return "172.17.0.2", nil },
	)
	defer restore()

	_, err := FindContainerByLabel(context.Background(), "devcontainer.local_folder", "/missing")
	if err == nil {
		t.Fatal("expected error when no container candidates match")
	}
	if !strings.Contains(err.Error(), "no running devcontainer found") {
		t.Fatalf("expected no-candidates error, got %v", err)
	}
}

func TestFindContainerByLabelPassesCancellationToDockerQuery(t *testing.T) {
	restore := stubDockerDiscovery(
		func(ctx context.Context, _, _ string) ([]containerCandidate, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
		func(context.Context, string) bool { return true },
		func(string) (string, error) { return "172.17.0.2", nil },
	)
	defer restore()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, err := FindContainerByLabel(ctx, "devcontainer.local_folder", "/workspace")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("FindContainerByLabel error = %v, want context deadline exceeded", err)
	}
}

func TestGetBridgeIPIsScopedToCurrentContainer(t *testing.T) {
	current := "first"
	restore := stubDockerDiscovery(
		func(context.Context, string, string) ([]containerCandidate, error) {
			return []containerCandidate{{id: current, createdAt: time.Now()}}, nil
		},
		func(context.Context, string) bool { return true },
		func(id string) (string, error) {
			switch id {
			case "first":
				return "172.17.0.2", nil
			case "second":
				return "172.17.0.3", nil
			default:
				return "", fmt.Errorf("unexpected container %s", id)
			}
		},
	)
	defer restore()

	discovery := NewDiscovery(Config{BridgeIPTTL: time.Minute})
	ip, err := discovery.GetBridgeIP()
	if err != nil {
		t.Fatalf("GetBridgeIP failed: %v", err)
	}
	if ip != "172.17.0.2" {
		t.Fatalf("expected first IP, got %q", ip)
	}

	current = "second"
	discovery.Invalidate()
	ip, err = discovery.GetBridgeIP()
	if err != nil {
		t.Fatalf("GetBridgeIP after container change failed: %v", err)
	}
	if ip != "172.17.0.3" {
		t.Fatalf("expected second IP, got %q", ip)
	}
}

func stubDockerDiscovery(
	list func(context.Context, string, string) ([]containerCandidate, error),
	running func(context.Context, string) bool,
	bridgeIP func(string) (string, error),
) func() {
	oldList := listRunningContainersByLabel
	oldRunning := isContainerRunning
	oldBridgeIP := inspectContainerBridgeIP
	listRunningContainersByLabel = list
	isContainerRunning = running
	inspectContainerBridgeIP = bridgeIP
	return func() {
		listRunningContainersByLabel = oldList
		isContainerRunning = oldRunning
		inspectContainerBridgeIP = oldBridgeIP
	}
}
