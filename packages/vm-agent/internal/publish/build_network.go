package publish

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Compose auto-discovery/overrides are resolved before augmentation. Never
// overwrite the user's compose files or include builder networking in releases.
func runComposeBuild(ctx context.Context, command string, opts BuildOptions, cfg *composeConfig, env map[string]string) ([]byte, error) {
	if opts.BuildNetwork == "" {
		return runCompose(ctx, command, opts.WorkspaceDir, env, "build")
	}
	if opts.BuildNetwork != "host" {
		return nil, fmt.Errorf("unsupported builder network")
	}
	base, err := runCompose(ctx, command, opts.WorkspaceDir, nil, "config", "--no-interpolate")
	if err != nil {
		return nil, err
	}
	temp, err := os.MkdirTemp("", "sam-build-network-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(temp)
	basePath := filepath.Join(temp, "compose.yaml")
	if err = os.WriteFile(basePath, base, 0600); err != nil {
		return nil, err
	}
	services := map[string]any{}
	for name, svc := range cfg.Services {
		if len(svc.Build) > 0 && string(svc.Build) != "null" {
			services[name] = map[string]any{"build": map[string]string{"network": "host"}}
		}
	}
	overlay, err := yaml.Marshal(map[string]any{"services": services})
	if err != nil {
		return nil, err
	}
	overlayPath := filepath.Join(temp, "network.yaml")
	if err = os.WriteFile(overlayPath, overlay, 0600); err != nil {
		return nil, err
	}
	return runCompose(ctx, command, opts.WorkspaceDir, env, "--project-directory", opts.WorkspaceDir, "-f", basePath, "-f", overlayPath, "build")
}
