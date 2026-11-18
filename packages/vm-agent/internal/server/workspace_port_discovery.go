package server

import (
	"fmt"
	"strings"

	"github.com/workspace/vm-agent/internal/container"
)

func (s *Server) resolveWorkspaceBridgeIP(workspaceID string) (string, error) {
	if s.config == nil {
		return "", fmt.Errorf("server config unavailable")
	}
	if !s.config.ContainerMode {
		return "127.0.0.1", nil
	}

	discovery, err := s.workspacePortDiscovery(workspaceID)
	if err != nil {
		return "", err
	}
	bridgeIP, err := discovery.GetBridgeIP()
	if err != nil {
		return "", fmt.Errorf("container bridge IP not available yet: %w", err)
	}
	return bridgeIP, nil
}

func (s *Server) workspacePortDiscovery(workspaceID string) (*container.Discovery, error) {
	if err := s.requireNoWorkspaceDeletion(workspaceID); err != nil {
		return nil, err
	}
	// Discovery caches are volatile. Resolve ownership from runtime metadata,
	// or durable metadata when this is the first request after an agent restart.
	// Never use the node-wide default label: it can select another workspace.
	s.workspaceMu.RLock()
	runtime, ok := s.workspaces[workspaceID]
	var labelValue string
	unavailable := false
	if ok && runtime != nil {
		labelValue = strings.TrimSpace(runtime.ContainerLabelValue)
		unavailable = runtime.MetadataUnavailable || runtime.Status == "evicted" || runtime.Status == "stopped" || runtime.Status == "stopping"
	}
	s.workspaceMu.RUnlock()
	if !ok && s.store != nil {
		meta, err := s.store.GetWorkspaceMetadata(workspaceID)
		if err != nil {
			return nil, fmt.Errorf("read workspace container route: %w", err)
		}
		if meta != nil {
			ok = true
			labelValue = strings.TrimSpace(meta.ContainerLabelVal)
			unavailable = meta.Evicted
		}
	}
	if !ok {
		return nil, fmt.Errorf("workspace container route is not registered")
	}
	if unavailable || labelValue == "" {
		return nil, fmt.Errorf("workspace container route is not available yet")
	}

	s.portScannerMu.RLock()
	existing := s.portDiscoveries[workspaceID]
	s.portScannerMu.RUnlock()
	if existing != nil {
		return existing, nil
	}

	discovery := container.NewDiscovery(container.Config{
		LabelKey:    s.config.ContainerLabelKey,
		LabelValue:  labelValue,
		CacheTTL:    s.config.ContainerCacheTTL,
		BridgeIPTTL: s.config.PortProxyCacheTTL,
	})

	s.portScannerMu.Lock()
	if s.portDiscoveries == nil {
		s.portDiscoveries = make(map[string]*container.Discovery)
	}
	if existing := s.portDiscoveries[workspaceID]; existing != nil {
		s.portScannerMu.Unlock()
		return existing, nil
	}
	s.portDiscoveries[workspaceID] = discovery
	s.portScannerMu.Unlock()
	return discovery, nil
}
