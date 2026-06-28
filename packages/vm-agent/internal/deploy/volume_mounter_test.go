package deploy

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeCommandRunner struct {
	responses map[string]struct {
		out string
		err error
	}
	calls []string
}

func (f *fakeCommandRunner) CombinedOutput(_ context.Context, name string, args ...string) ([]byte, error) {
	call := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, call)
	if response, ok := f.responses[call]; ok {
		return []byte(response.out), response.err
	}
	return nil, nil
}

func (f *fakeCommandRunner) called(prefix string) bool {
	for _, call := range f.calls {
		if strings.HasPrefix(call, prefix) {
			return true
		}
	}
	return false
}

func TestRealVolumeMounter_FormatOnlyIfEmpty(t *testing.T) {
	device := filepath.Join(t.TempDir(), "vol")
	if err := os.WriteFile(device, []byte("block"), 0644); err != nil {
		t.Fatalf("write fake device: %v", err)
	}
	fstab := filepath.Join(t.TempDir(), "fstab")
	runner := &fakeCommandRunner{responses: map[string]struct {
		out string
		err error
	}{
		"blkid " + device:                  {err: errors.New("no filesystem")},
		"wipefs -n " + device:              {},
		"blkid -s UUID -o value " + device: {out: "uuid-123\n"},
	}}
	mountRoot := filepath.Join(t.TempDir(), "mnt")
	runner.responses["mountpoint -q "+mountRoot] = struct {
		out string
		err error
	}{err: errors.New("not mounted")}
	runner.responses["mount "+device+" "+mountRoot] = struct {
		out string
		err error
	}{}

	mounter := &RealVolumeMounter{runner: runner, fstabPath: fstab}
	err := mounter.MountVolumes(context.Background(), []VolumeMount{{
		Name:             "data",
		MountRoot:        mountRoot,
		ProviderVolumeID: "vol-raw",
		ProviderName:     "scaleway",
		LinuxDevice:      device,
		FSFormat:         "ext4",
	}})
	if err != nil {
		t.Fatalf("MountVolumes: %v", err)
	}
	if !runner.called("mkfs.ext4 -F " + device) {
		t.Fatal("expected empty raw device to be formatted")
	}
}

func TestRealVolumeMounter_DoesNotFormatExistingFilesystem(t *testing.T) {
	device := filepath.Join(t.TempDir(), "vol")
	if err := os.WriteFile(device, []byte("block"), 0644); err != nil {
		t.Fatalf("write fake device: %v", err)
	}
	mountRoot := filepath.Join(t.TempDir(), "mnt")
	fstab := filepath.Join(t.TempDir(), "fstab")
	runner := &fakeCommandRunner{responses: map[string]struct {
		out string
		err error
	}{
		"blkid " + device:                   {out: device + ": UUID=\"uuid-123\" TYPE=\"ext4\"\n"},
		"blkid -s UUID -o value " + device:  {out: "uuid-123\n"},
		"mountpoint -q " + mountRoot:        {err: errors.New("not mounted")},
		"mount " + device + " " + mountRoot: {},
	}}

	mounter := &RealVolumeMounter{runner: runner, fstabPath: fstab}
	err := mounter.MountVolumes(context.Background(), []VolumeMount{{
		Name:             "data",
		MountRoot:        mountRoot,
		ProviderVolumeID: "vol-formatted",
		ProviderName:     "hetzner",
		LinuxDevice:      device,
		FSFormat:         "ext4",
	}})
	if err != nil {
		t.Fatalf("MountVolumes: %v", err)
	}
	if runner.called("mkfs.ext4") {
		t.Fatal("existing filesystem must not be formatted")
	}
}

func TestRealVolumeMounter_RefusesWipefsSignatures(t *testing.T) {
	device := filepath.Join(t.TempDir(), "vol")
	if err := os.WriteFile(device, []byte("block"), 0644); err != nil {
		t.Fatalf("write fake device: %v", err)
	}
	runner := &fakeCommandRunner{responses: map[string]struct {
		out string
		err error
	}{
		"blkid " + device:     {err: errors.New("no filesystem")},
		"wipefs -n " + device: {out: "offset type\n0x1 dos\n"},
	}}
	mounter := &RealVolumeMounter{runner: runner, fstabPath: filepath.Join(t.TempDir(), "fstab")}
	err := mounter.MountVolumes(context.Background(), []VolumeMount{{
		Name:             "data",
		MountRoot:        filepath.Join(t.TempDir(), "mnt"),
		ProviderVolumeID: "vol-risk",
		ProviderName:     "scaleway",
		LinuxDevice:      device,
		FSFormat:         "ext4",
	}})
	if err == nil || !strings.Contains(err.Error(), "refusing to format") {
		t.Fatalf("expected refusal to format non-empty signatures, got %v", err)
	}
	if runner.called("mkfs.ext4") {
		t.Fatal("mkfs must not run when wipefs reports signatures")
	}
}

func TestRealVolumeMounter_DiscoversScalewayDeviceWithLsblkSerial(t *testing.T) {
	mountRoot := filepath.Join(t.TempDir(), "mnt")
	fstab := filepath.Join(t.TempDir(), "fstab")
	runner := &fakeCommandRunner{responses: map[string]struct {
		out string
		err error
	}{
		"lsblk -ndo PATH,SERIAL":          {out: "/dev/sdb scw-vol-abc\n"},
		"blkid /dev/sdb":                  {out: "/dev/sdb: UUID=\"uuid\" TYPE=\"ext4\"\n"},
		"blkid -s UUID -o value /dev/sdb": {out: "uuid\n"},
		"mountpoint -q " + mountRoot:      {err: errors.New("not mounted")},
		"mount /dev/sdb " + mountRoot:     {},
	}}
	mounter := &RealVolumeMounter{runner: runner, fstabPath: fstab}
	err := mounter.MountVolumes(context.Background(), []VolumeMount{{
		Name:             "data",
		MountRoot:        mountRoot,
		ProviderVolumeID: "scw-vol-abc",
		ProviderName:     "scaleway",
		FSFormat:         "ext4",
	}})
	if err != nil {
		t.Fatalf("MountVolumes: %v", err)
	}
	if !runner.called("mount /dev/sdb " + mountRoot) {
		t.Fatal("expected discovered device to be mounted")
	}
}

func TestRealVolumeMounter_SkipsMountWhenAlreadyMounted(t *testing.T) {
	device := filepath.Join(t.TempDir(), "vol")
	if err := os.WriteFile(device, []byte("block"), 0644); err != nil {
		t.Fatalf("write fake device: %v", err)
	}
	mountRoot := filepath.Join(t.TempDir(), "mnt")
	fstab := filepath.Join(t.TempDir(), "fstab")
	runner := &fakeCommandRunner{responses: map[string]struct {
		out string
		err error
	}{
		"blkid " + device:                  {out: device + ": UUID=\"uuid-123\" TYPE=\"ext4\"\n"},
		"mountpoint -q " + mountRoot:       {},
		"blkid -s UUID -o value " + device: {out: "uuid-123\n"},
	}}

	mounter := &RealVolumeMounter{runner: runner, fstabPath: fstab}
	err := mounter.MountVolumes(context.Background(), []VolumeMount{{
		Name:             "data",
		MountRoot:        mountRoot,
		ProviderVolumeID: "vol-formatted",
		ProviderName:     "hetzner",
		LinuxDevice:      device,
		FSFormat:         "ext4",
	}})
	if err != nil {
		t.Fatalf("MountVolumes: %v", err)
	}
	if runner.called("mount " + device + " " + mountRoot) {
		t.Fatal("already-mounted volume should not be mounted again")
	}
}
