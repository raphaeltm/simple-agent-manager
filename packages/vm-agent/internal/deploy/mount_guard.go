package deploy

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// SAM volume mount path prefix. Bind mounts under this tree originate from
// provider-attached block volumes and MUST be real mountpoints before containers
// start. A fell-through empty directory (mount path exists as a regular dir but
// no device is mounted there) means the volume was never attached or was
// detached — starting containers against it would silently use ephemeral
// node-local storage, violating the "data is detachable" contract.
const samVolumeMountPrefix = "/mnt/sam-env-"

// MountChecker abstracts the filesystem check so tests can inject a fake.
type MountChecker interface {
	// IsMountpoint returns true if the given path is a real mountpoint
	// (backed by a different device than its parent). Returns false if the
	// path does not exist or is a regular directory on the root filesystem.
	IsMountpoint(path string) (bool, error)
}

// RealMountChecker checks the actual filesystem.
type RealMountChecker struct{}

// IsMountpoint reports whether path is a mountpoint by comparing its device ID
// with the device ID of its parent directory. If they differ, path is a
// separate mount.
func (RealMountChecker) IsMountpoint(path string) (bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return false, fmt.Errorf("%s is not a directory", path)
	}

	parentInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		return false, err
	}

	return deviceID(info) != deviceID(parentInfo), nil
}

// composeVolumeMounts is a minimal representation of a Docker Compose file,
// used only to extract the volumes fields from each service.
type composeVolumeMounts struct {
	Services map[string]struct {
		Volumes []composeVolumeEntry `yaml:"volumes"`
	} `yaml:"services"`
}

type composeVolumeEntry struct {
	raw    string
	source string
}

func (v *composeVolumeEntry) UnmarshalYAML(node *yaml.Node) error {
	switch node.Kind {
	case yaml.ScalarNode:
		var value string
		if err := node.Decode(&value); err != nil {
			return err
		}
		v.raw = value
		return nil
	case yaml.MappingNode:
		var value struct {
			Source string `yaml:"source"`
			Src    string `yaml:"src"`
		}
		if err := node.Decode(&value); err != nil {
			return err
		}
		v.source = value.Source
		if v.source == "" {
			v.source = value.Src
		}
		return nil
	default:
		return nil
	}
}

func (v composeVolumeEntry) hostPath() string {
	if v.source != "" {
		return v.source
	}
	// Bind mount format: /host/path:/container/path[:options]
	parts := strings.SplitN(v.raw, ":", 2)
	if len(parts) < 2 {
		return ""
	}
	return parts[0]
}

// extractSAMVolumeMountRoots parses rendered Docker Compose YAML and returns
// the set of host-side SAM volume mount root directories that need to be
// verified. Each volume bind mount follows the pattern:
//
//	/mnt/sam-env-{environmentId}/volumes/{name}:{containerPath}
//
// We check the environment-level mount root (/mnt/sam-env-{environmentId})
// because that is where the provider block volume is mounted.
func extractSAMVolumeMountRoots(composeYAML string) ([]string, error) {
	var compose composeVolumeMounts
	if err := yaml.Unmarshal([]byte(composeYAML), &compose); err != nil {
		// If the YAML cannot be parsed for volume extraction, return empty.
		// Invalid YAML will fail later at `docker compose up` anyway; the
		// mount guard only needs to protect against valid compose files that
		// reference SAM volumes on unmounted paths.
		slog.Warn("deploy.mountGuard: could not parse compose YAML for volume check — guard skipped", "error", err)
		return nil, nil
	}

	seen := make(map[string]bool)
	var roots []string

	for _, svc := range compose.Services {
		for _, vol := range svc.Volumes {
			hostPath := vol.hostPath()
			if !strings.HasPrefix(hostPath, samVolumeMountPrefix) {
				continue
			}

			// Extract the environment mount root: /mnt/sam-env-{envId}
			// The host path is /mnt/sam-env-{envId}/volumes/{name}
			// samVolumeMountPrefix is "/mnt/sam-env-" so the remainder
			// after the prefix is "{envId}/volumes/{name}".
			remainder := hostPath[len(samVolumeMountPrefix):]
			// Get just the envId part (everything before the first '/')
			slashIdx := strings.Index(remainder, "/")
			var envDir string
			if slashIdx == -1 {
				envDir = remainder
			} else {
				envDir = remainder[:slashIdx]
			}

			// Reject path traversal components in the envId segment.
			// Compose YAML is signed by the control plane so this is
			// defense-in-depth, not a primary security boundary.
			if envDir == "" || envDir == "." || envDir == ".." || strings.ContainsAny(envDir, "/\\") {
				slog.Warn("deploy.mountGuard: skipping suspicious volume path", "hostPath", hostPath)
				continue
			}

			root := samVolumeMountPrefix + envDir

			if !seen[root] {
				seen[root] = true
				roots = append(roots, root)
			}
		}
	}

	return roots, nil
}

// verifyVolumeMounts checks that all SAM volume mount roots in the compose YAML
// are real mountpoints. Returns nil if no SAM volumes are declared or all are
// mounted. Returns a descriptive error listing missing/unmounted volumes.
func verifyVolumeMounts(composeYAML string, checker MountChecker) error {
	roots, err := extractSAMVolumeMountRoots(composeYAML)
	if err != nil {
		return fmt.Errorf("volume mount guard: %w", err)
	}

	if len(roots) == 0 {
		slog.Debug("deploy.mountGuard: no SAM volume mounts declared — skipping check")
		return nil
	}

	var missing []string
	for _, root := range roots {
		mounted, err := checker.IsMountpoint(root)
		if err != nil {
			missing = append(missing, fmt.Sprintf("%s (check failed: %v)", root, err))
			continue
		}
		if !mounted {
			missing = append(missing, fmt.Sprintf("%s (exists but is not a mountpoint)", root))
			continue
		}
		slog.Info("deploy.mountGuard: volume mount verified", "path", root)
	}

	if len(missing) > 0 {
		return fmt.Errorf(
			"volume mount guard: refusing to apply — %d required volume mount(s) not attached: %s. "+
				"Attach the volume to this node before applying the release",
			len(missing), strings.Join(missing, "; "))
	}

	return nil
}
