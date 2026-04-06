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
	IPAddress     string // Container's IP on the network (for --add-host DNS fallback)
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

	// Parse network details including IP addresses
	type networkEndpoint struct {
		IPAddress string `json:"IPAddress"`
	}
	var networks map[string]networkEndpoint
	if err := json.Unmarshal(netOut, &networks); err != nil {
		return nil, fmt.Errorf("failed to parse network info: %w", err)
	}

	// Pick the first non-default network (devcontainer creates a project-specific one).
	// Fall back to any network if all are default.
	var networkName string
	var ipAddress string
	for name, ep := range networks {
		if name != "bridge" && name != "host" && name != "none" {
			networkName = name
			ipAddress = ep.IPAddress
			break
		}
	}
	if networkName == "" {
		// Fallback: use "bridge" if no custom network found
		for name, ep := range networks {
			networkName = name
			ipAddress = ep.IPAddress
			break
		}
	}

	if networkName == "" {
		return nil, fmt.Errorf("container %s has no networks", containerID)
	}

	return &ContainerNetworkInfo{
		ContainerName: containerName,
		NetworkName:   networkName,
		IPAddress:     ipAddress,
	}, nil
}
