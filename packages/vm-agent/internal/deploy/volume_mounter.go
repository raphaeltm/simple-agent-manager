package deploy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

const defaultFstabPath = "/etc/fstab"

var fstabMu sync.Mutex

type VolumeMounter interface {
	MountVolumes(ctx context.Context, volumes []VolumeMount) error
}

type VolumeTeardowner interface {
	TeardownMounts(ctx context.Context, mountRoots []string) error
}

type CommandRunner interface {
	CombinedOutput(ctx context.Context, name string, args ...string) ([]byte, error)
}

type execCommandRunner struct{}

func (execCommandRunner) CombinedOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

type RealVolumeMounter struct {
	runner    CommandRunner
	fstabPath string
}

func NewRealVolumeMounter() *RealVolumeMounter {
	return &RealVolumeMounter{runner: execCommandRunner{}, fstabPath: defaultFstabPath}
}

func (m *RealVolumeMounter) MountVolumes(ctx context.Context, volumes []VolumeMount) error {
	for _, volume := range volumes {
		if err := m.mountVolume(ctx, volume); err != nil {
			return err
		}
	}
	return nil
}

func (m *RealVolumeMounter) mountVolume(ctx context.Context, volume VolumeMount) error {
	if err := validateVolumeMountFields(volume); err != nil {
		return err
	}
	if volume.MountRoot == "" {
		return fmt.Errorf("volume %q missing mountRoot", volume.Name)
	}
	device, err := m.resolveDevice(ctx, volume)
	if err != nil {
		return fmt.Errorf("volume %q device discovery: %w", volume.Name, err)
	}
	if err := m.ensureFilesystem(ctx, device, volume); err != nil {
		return fmt.Errorf("volume %q filesystem: %w", volume.Name, err)
	}
	if err := os.MkdirAll(volume.MountRoot, 0755); err != nil {
		return fmt.Errorf("create mount root %s: %w", volume.MountRoot, err)
	}
	if out, err := m.runner.CombinedOutput(ctx, "mountpoint", "-q", volume.MountRoot); err != nil {
		if out, err := m.runner.CombinedOutput(ctx, "mount", device, volume.MountRoot); err != nil {
			return fmt.Errorf("mount %s at %s: %w: %s", device, volume.MountRoot, err, strings.TrimSpace(string(out)))
		}
	} else if len(bytes.TrimSpace(out)) > 0 {
		return fmt.Errorf("mountpoint probe for %s returned unexpected output: %s", volume.MountRoot, strings.TrimSpace(string(out)))
	}
	if err := m.ensureFstab(ctx, device, volume.MountRoot); err != nil {
		return err
	}
	return nil
}

func (m *RealVolumeMounter) resolveDevice(ctx context.Context, volume VolumeMount) (string, error) {
	if volume.LinuxDevice != "" {
		if _, err := os.Stat(volume.LinuxDevice); err != nil {
			return "", err
		}
		return volume.LinuxDevice, nil
	}

	if volume.ProviderVolumeID == "" {
		return "", errors.New("providerVolumeId is required for device discovery when linuxDevice is empty")
	}

	for _, pattern := range []string{"/dev/disk/by-id/*" + volume.ProviderVolumeID + "*"} {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			return "", err
		}
		if len(matches) > 0 {
			return matches[0], nil
		}
	}

	out, err := m.runner.CombinedOutput(ctx, "lsblk", "-ndo", "PATH,SERIAL")
	if err != nil {
		return "", fmt.Errorf("lsblk discovery failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		serial := strings.Join(fields[1:], " ")
		if strings.Contains(serial, volume.ProviderVolumeID) {
			return fields[0], nil
		}
	}
	return "", errors.New("no matching block device found")
}

func (m *RealVolumeMounter) ensureFilesystem(ctx context.Context, device string, volume VolumeMount) error {
	format := volume.FSFormat
	if format == "" {
		format = "ext4"
	}
	if format != "ext4" {
		return fmt.Errorf("unsupported filesystem format %q", format)
	}
	if _, err := m.runner.CombinedOutput(ctx, "blkid", device); err == nil {
		return nil
	}
	out, err := m.runner.CombinedOutput(ctx, "wipefs", "-n", device)
	if err != nil {
		return fmt.Errorf("wipefs probe failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if strings.TrimSpace(string(out)) != "" {
		return fmt.Errorf("refusing to format %s: existing non-filesystem signatures detected by wipefs", device)
	}
	if out, err := m.runner.CombinedOutput(ctx, "mkfs.ext4", "-F", device); err != nil {
		return fmt.Errorf("mkfs.ext4 failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (m *RealVolumeMounter) ensureFstab(ctx context.Context, device, mountRoot string) error {
	spec := device
	if out, err := m.runner.CombinedOutput(ctx, "blkid", "-s", "UUID", "-o", "value", device); err == nil {
		if uuid := strings.TrimSpace(string(out)); uuid != "" {
			spec = "UUID=" + uuid
		}
	}
	if err := validateFstabField("volume spec", spec); err != nil {
		return err
	}
	if err := validateFstabField("mount root", mountRoot); err != nil {
		return err
	}
	line := fmt.Sprintf("%s %s ext4 defaults,nofail 0 2", spec, mountRoot)

	fstabMu.Lock()
	defer fstabMu.Unlock()

	existing, err := os.ReadFile(m.fstabPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read fstab: %w", err)
	}
	if bytes.Contains(existing, []byte(" "+mountRoot+" ")) || bytes.Contains(existing, []byte("\t"+mountRoot+"\t")) {
		return nil
	}
	if len(existing) > 0 && !bytes.HasSuffix(existing, []byte("\n")) {
		existing = append(existing, '\n')
	}
	existing = append(existing, []byte(line+"\n")...)
	if err := os.WriteFile(m.fstabPath, existing, 0644); err != nil {
		return fmt.Errorf("write fstab: %w", err)
	}
	return nil
}

func (m *RealVolumeMounter) TeardownMounts(ctx context.Context, mountRoots []string) error {
	var errs []string
	for _, mountRoot := range uniqueMountRoots(mountRoots) {
		if err := m.teardownMount(ctx, mountRoot); err != nil {
			errs = append(errs, err.Error())
		}
	}
	return joinedError(errs)
}

func uniqueMountRoots(mountRoots []string) []string {
	seen := make(map[string]bool, len(mountRoots))
	unique := make([]string, 0, len(mountRoots))
	for _, mountRoot := range mountRoots {
		mountRoot = strings.TrimSpace(mountRoot)
		if mountRoot == "" || seen[mountRoot] {
			continue
		}
		seen[mountRoot] = true
		unique = append(unique, mountRoot)
	}
	return unique
}

func (m *RealVolumeMounter) teardownMount(ctx context.Context, mountRoot string) error {
	var errs []string
	if err := validateTeardownMountRoot(mountRoot); err != nil {
		return err
	}
	if err := m.unmountIfMounted(ctx, mountRoot); err != nil {
		errs = append(errs, err.Error())
	}
	if err := m.removeFstabEntry(mountRoot); err != nil {
		errs = append(errs, err.Error())
	}
	return joinedError(errs)
}

func validateTeardownMountRoot(mountRoot string) error {
	if err := validateFstabField("mount root", mountRoot); err != nil {
		return err
	}
	if filepath.Clean(mountRoot) != mountRoot || !strings.HasPrefix(mountRoot, samVolumeMountPrefix) {
		return fmt.Errorf("mount root %q is not a canonical SAM volume path", mountRoot)
	}
	return nil
}

func (m *RealVolumeMounter) unmountIfMounted(ctx context.Context, mountRoot string) error {
	out, err := m.runner.CombinedOutput(ctx, "mountpoint", "-q", mountRoot)
	if err != nil {
		return nil
	}

	var errs []string
	if len(bytes.TrimSpace(out)) > 0 {
		errs = append(errs, fmt.Sprintf("mountpoint probe for %s returned unexpected output: %s", mountRoot, strings.TrimSpace(string(out))))
	}
	if out, err := m.runner.CombinedOutput(ctx, "umount", mountRoot); err != nil {
		errs = append(errs, fmt.Sprintf("umount %s: %v: %s", mountRoot, err, strings.TrimSpace(string(out))))
	}
	return joinedError(errs)
}

func joinedError(parts []string) error {
	if len(parts) == 0 {
		return nil
	}
	return errors.New(strings.Join(parts, "; "))
}

func (m *RealVolumeMounter) removeFstabEntry(mountRoot string) error {
	fstabMu.Lock()
	defer fstabMu.Unlock()

	existing, err := os.ReadFile(m.fstabPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read fstab: %w", err)
	}

	lines := strings.Split(string(existing), "\n")
	kept := make([]string, 0, len(lines))
	removed := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			kept = append(kept, line)
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == mountRoot {
			removed = true
			continue
		}
		kept = append(kept, line)
	}
	if !removed {
		return nil
	}

	next := strings.Join(kept, "\n")
	if strings.HasSuffix(string(existing), "\n") && !strings.HasSuffix(next, "\n") {
		next += "\n"
	}
	if err := os.WriteFile(m.fstabPath, []byte(next), 0644); err != nil {
		return fmt.Errorf("write fstab: %w", err)
	}
	return nil
}

func validateVolumeMountFields(volume VolumeMount) error {
	if containsWhitespaceOrControl(volume.LinuxDevice) {
		return fmt.Errorf("volume %q linuxDevice contains whitespace or control characters", volume.Name)
	}
	if containsWhitespaceOrControl(volume.ProviderVolumeID) {
		return fmt.Errorf("volume %q providerVolumeId contains whitespace or control characters", volume.Name)
	}
	if containsWhitespaceOrControl(volume.MountRoot) {
		return fmt.Errorf("volume %q mountRoot contains whitespace or control characters", volume.Name)
	}
	if volume.MountRoot != "" && filepath.Clean(volume.MountRoot) != volume.MountRoot {
		return fmt.Errorf("volume %q mountRoot %q is not canonical", volume.Name, volume.MountRoot)
	}
	return nil
}

func validateFstabField(label, value string) error {
	if value == "" {
		return fmt.Errorf("%s is empty", label)
	}
	if containsWhitespaceOrControl(value) {
		return fmt.Errorf("%s %q contains whitespace or control characters", label, value)
	}
	return nil
}
