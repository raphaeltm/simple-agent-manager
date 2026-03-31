package browser

import (
	"context"
	"fmt"
	"testing"
)

func TestDiscoverContainerNetwork_CustomNetwork(t *testing.T) {
	docker := newMockDocker()
	docker.outputs[`inspect -f {{.Name}} container-abc`] = "/my-devcontainer\n"
	docker.outputs[`inspect -f {{json .NetworkSettings.Networks}} container-abc`] = `{"my-custom-network":{}, "bridge":{}}`

	info, err := DiscoverContainerNetwork(context.Background(), docker, "container-abc")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.ContainerName != "my-devcontainer" {
		t.Errorf("expected container name 'my-devcontainer', got %q", info.ContainerName)
	}
	if info.NetworkName != "my-custom-network" {
		t.Errorf("expected network 'my-custom-network', got %q", info.NetworkName)
	}
}

func TestDiscoverContainerNetwork_BridgeFallback(t *testing.T) {
	docker := newMockDocker()
	docker.outputs[`inspect -f {{.Name}} container-abc`] = "/my-container\n"
	docker.outputs[`inspect -f {{json .NetworkSettings.Networks}} container-abc`] = `{"bridge":{}}`

	info, err := DiscoverContainerNetwork(context.Background(), docker, "container-abc")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.NetworkName != "bridge" {
		t.Errorf("expected fallback to 'bridge', got %q", info.NetworkName)
	}
}

func TestDiscoverContainerNetwork_NoNetworks(t *testing.T) {
	docker := newMockDocker()
	docker.outputs[`inspect -f {{.Name}} container-abc`] = "/my-container\n"
	docker.outputs[`inspect -f {{json .NetworkSettings.Networks}} container-abc`] = `{}`

	_, err := DiscoverContainerNetwork(context.Background(), docker, "container-abc")
	if err == nil {
		t.Fatal("expected error for empty networks")
	}
}

func TestDiscoverContainerNetwork_MalformedJSON(t *testing.T) {
	docker := newMockDocker()
	docker.outputs[`inspect -f {{.Name}} container-abc`] = "/my-container\n"
	docker.outputs[`inspect -f {{json .NetworkSettings.Networks}} container-abc`] = `not-json`

	_, err := DiscoverContainerNetwork(context.Background(), docker, "container-abc")
	if err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}

func TestDiscoverContainerNetwork_InspectFailure(t *testing.T) {
	docker := newMockDocker()
	docker.errors[`inspect -f {{.Name}} container-abc`] = fmt.Errorf("container not found")

	_, err := DiscoverContainerNetwork(context.Background(), docker, "container-abc")
	if err == nil {
		t.Fatal("expected error when inspect fails")
	}
}

func TestDiscoverContainerNetwork_SkipsDefaultNetworks(t *testing.T) {
	docker := newMockDocker()
	docker.outputs[`inspect -f {{.Name}} cid`] = "/c\n"
	docker.outputs[`inspect -f {{json .NetworkSettings.Networks}} cid`] = `{"host":{}, "none":{}, "devnet":{}}`

	info, err := DiscoverContainerNetwork(context.Background(), docker, "cid")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.NetworkName != "devnet" {
		t.Errorf("expected 'devnet', got %q", info.NetworkName)
	}
}
