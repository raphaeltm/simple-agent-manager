package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// ContainerNetworkInfo contains the Docker network details for a container.
type ContainerNetworkInfo struct {
	ContainerName string
	NetworkName   string
}

// DiscoverContainerNetwork finds the Docker network and container name for a container ID.
// The DevContainer CLI creates a Docker network automatically; this discovers it.
func DiscoverContainerNetwork(ctx context.Context, docker DockerExecutor, containerID string) (*ContainerNetworkInfo, error) {
	// Get container name
	nameOut, err := docker.Run(ctx, "inspect", "-f", "{{.Name}}", containerID)
	if err != nil {
		return nil, fmt.Errorf("failed to inspect container name: %w", err)
	}
	containerName := strings.TrimPrefix(trimOutput(nameOut), "/")

	// Get network names — Docker format template lists all networks
	netOut, err := docker.Run(ctx, "inspect", "-f", "{{json .NetworkSettings.Networks}}", containerID)
	if err != nil {
		return nil, fmt.Errorf("failed to inspect container networks: %w", err)
	}

	var networks map[string]json.RawMessage
	if err := json.Unmarshal(netOut, &networks); err != nil {
		return nil, fmt.Errorf("failed to parse network info: %w", err)
	}

	// Pick the first non-default network (devcontainer creates a project-specific one).
	// Fall back to any network if all are default.
	var networkName string
	for name := range networks {
		if name != "bridge" && name != "host" && name != "none" {
			networkName = name
			break
		}
	}
	if networkName == "" {
		// Fallback: use "bridge" if no custom network found
		for name := range networks {
			networkName = name
			break
		}
	}

	if networkName == "" {
		return nil, fmt.Errorf("container %s has no networks", containerID)
	}

	return &ContainerNetworkInfo{
		ContainerName: containerName,
		NetworkName:   networkName,
	}, nil
}
