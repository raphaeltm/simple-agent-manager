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
)

const defaultFstabPath = "/etc/fstab"

type VolumeMounter interface {
	MountVolumes(ctx context.Context, volumes []VolumeMount) error
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

	for _, pattern := range []string{"/dev/disk/by-id/*" + volume.ProviderVolumeID + "*", "/dev/disk/by-id/*" + volume.Name + "*"} {
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
		if strings.Contains(serial, volume.ProviderVolumeID) || strings.Contains(serial, volume.Name) {
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
	line := fmt.Sprintf("%s %s ext4 defaults,nofail 0 2", spec, mountRoot)
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
