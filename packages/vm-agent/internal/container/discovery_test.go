package container

import (
	"fmt"
	"testing"
	"time"
)

func TestGetContainerIDRediscoveresStaleCachedContainer(t *testing.T) {
	restore := stubDockerDiscovery(
		func(string, string) ([]containerCandidate, error) {
			return []containerCandidate{{id: "fresh", createdAt: time.Now()}}, nil
		},
		func(id string) bool {
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
		func(string, string) ([]containerCandidate, error) {
			return []containerCandidate{
				{id: "older", createdAt: older},
				{id: "newer", createdAt: newer},
			}, nil
		},
		func(string) bool { return true },
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

func TestGetBridgeIPIsScopedToCurrentContainer(t *testing.T) {
	current := "first"
	restore := stubDockerDiscovery(
		func(string, string) ([]containerCandidate, error) {
			return []containerCandidate{{id: current, createdAt: time.Now()}}, nil
		},
		func(string) bool { return true },
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
	list func(string, string) ([]containerCandidate, error),
	running func(string) bool,
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
