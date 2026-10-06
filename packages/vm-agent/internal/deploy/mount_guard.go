package deploy

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"
)

// SAM volume mount path prefix. Bind mounts under this tree originate from
// provider-attached block volumes and MUST be real mountpoints before containers
// start. A fell-through empty directory (mount path exists as a regular dir but
// no device is mounted there) means the volume was never attached or was
// detached — starting containers against it would silently use ephemeral
// node-local storage, violating the "data is detachable" contract.
const samVolumeMountPrefix = "/mnt/sam-env-"

// Keep this volume name contract in sync with
// packages/shared/src/compose-parser/constants.ts.
const samVolumeNamePatternSource = `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`

const samVolumeBindDataDir = "data"

var volumeNamePattern = regexp.MustCompile(samVolumeNamePatternSource)

// MountChecker abstracts the filesystem check so tests can inject a fake.
type MountChecker interface {
	// IsMountpoint returns true if the given path is a real mountpoint
	// (backed by a different device than its parent). Returns false if the
	// path does not exist or is a regular directory on the root filesystem.
	IsMountpoint(path string) (bool, error)
	// IsDir returns true if the given path exists and is a directory.
	IsDir(path string) (bool, error)
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

func (RealMountChecker) IsDir(path string) (bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	return info.IsDir(), nil
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
// the set of host-side SAM named volume mountpoint directories that need to be
// verified. Each volume bind mount follows the pattern:
//
//	/mnt/sam-env-{environmentId}/volumes/{name}/data:{containerPath}
//
// Each provider block volume is mounted at its named volume path, while
// containers bind the post-mount data subdirectory to avoid ext4 lost+found.
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

			// Extract the named volume mountpoint from the bind source:
			// /mnt/sam-env-{envId}/volumes/{name}/data
			remainder := hostPath[len(samVolumeMountPrefix):]
			parts := strings.Split(remainder, "/")

			// Reject path traversal components in parsed path segments.
			// Compose YAML is signed by the control plane so this is
			// defense-in-depth, not a primary security boundary.
			if len(parts) == 3 && parts[1] == "volumes" && isSafeMountPathSegment(parts[0]) && isSafeMountPathSegment(parts[2]) {
				return nil, fmt.Errorf("raw SAM volume root bind source %q is not allowed; expected %q", hostPath, hostPath+"/"+samVolumeBindDataDir)
			}
			if len(parts) != 4 || parts[1] != "volumes" || parts[3] != samVolumeBindDataDir || !isSafeMountPathSegment(parts[0]) || !isSafeMountPathSegment(parts[2]) {
				slog.Warn("deploy.mountGuard: skipping suspicious volume path", "hostPath", hostPath)
				continue
			}

			root := samVolumeMountPrefix + parts[0] + "/volumes/" + parts[2]

			if !seen[root] {
				seen[root] = true
				roots = append(roots, root)
			}
		}
	}

	return roots, nil
}

func isSafeMountPathSegment(segment string) bool {
	return segment != "" && segment != "." && segment != ".." && !strings.ContainsAny(segment, "/\\")
}

func expectedVolumeMountRoot(environmentID, volumeName string) string {
	return samVolumeMountPrefix + environmentID + "/volumes/" + volumeName
}

func containsWhitespaceOrControl(value string) bool {
	return strings.IndexFunc(value, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}) >= 0
}

func validateVolumeMountsForEnvironment(environmentID string, volumes []VolumeMount) error {
	if len(volumes) == 0 {
		return nil
	}
	if !isSafeMountPathSegment(environmentID) || containsWhitespaceOrControl(environmentID) {
		return fmt.Errorf("unsafe environment id %q", environmentID)
	}

	for _, volume := range volumes {
		if err := validateVolumeMountForEnvironment(environmentID, volume); err != nil {
			return err
		}
	}
	return nil
}

func validateVolumeMountForEnvironment(environmentID string, volume VolumeMount) error {
	if !volumeNamePattern.MatchString(volume.Name) {
		return fmt.Errorf("volume %q has an unsafe name", volume.Name)
	}
	if containsWhitespaceOrControl(volume.MountRoot) {
		return fmt.Errorf("volume %q mountRoot contains whitespace or control characters", volume.Name)
	}
	cleanRoot := filepath.Clean(volume.MountRoot)
	expectedRoot := expectedVolumeMountRoot(environmentID, volume.Name)
	if cleanRoot != volume.MountRoot || cleanRoot != expectedRoot {
		return fmt.Errorf("volume %q mountRoot %q must exactly match %q", volume.Name, volume.MountRoot, expectedRoot)
	}
	if volume.LinuxDevice != "" && containsWhitespaceOrControl(volume.LinuxDevice) {
		return fmt.Errorf("volume %q linuxDevice contains whitespace or control characters", volume.Name)
	}
	if volume.ProviderVolumeID == "" || containsWhitespaceOrControl(volume.ProviderVolumeID) {
		return fmt.Errorf("volume %q providerVolumeId is missing or unsafe", volume.Name)
	}
	return nil
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
		dataDir := filepath.Join(root, samVolumeBindDataDir)
		isDir, err := checker.IsDir(dataDir)
		if err != nil {
			missing = append(missing, fmt.Sprintf("%s (data dir check failed: %v)", dataDir, err))
			continue
		}
		if !isDir {
			missing = append(missing, fmt.Sprintf("%s (data dir is missing or not a directory)", dataDir))
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
