package deploy

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type cmdResponse struct {
	out string
	err error
}

type fakeCommandRunner struct {
	responses map[string]cmdResponse
	calls     []string
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

type fstabUUIDRunner struct{}

func (fstabUUIDRunner) CombinedOutput(_ context.Context, name string, args ...string) ([]byte, error) {
	if name == "blkid" && len(args) == 5 && args[0] == "-s" && args[1] == "UUID" {
		uuid := strings.TrimLeft(strings.ReplaceAll(args[4], "/", "-"), "-")
		return []byte("uuid-" + uuid + "\n"), nil
	}
	return nil, nil
}

// writeFakeDevice creates a fake block-device file and returns its path.
func writeFakeDevice(t *testing.T) string {
	t.Helper()
	device := filepath.Join(t.TempDir(), "vol")
	if err := os.WriteFile(device, []byte("block"), 0644); err != nil {
		t.Fatalf("write fake device: %v", err)
	}
	return device
}

// newAlreadyMountedExt4Runner returns a runner simulating a formatted ext4
// device whose mount root is already mounted (mountpoint -q succeeds).
func newAlreadyMountedExt4Runner(device, mountRoot string) *fakeCommandRunner {
	return &fakeCommandRunner{responses: map[string]cmdResponse{
		"blkid " + device:                  {out: device + ": UUID=\"uuid-123\" TYPE=\"ext4\"\n"},
		"mountpoint -q " + mountRoot:       {},
		"blkid -s UUID -o value " + device: {out: "uuid-123\n"},
	}}
}

// mountFormattedHetznerVolume runs MountVolumes for a pre-formatted hetzner
// volume and fails the test on error.
func mountFormattedHetznerVolume(t *testing.T, runner *fakeCommandRunner, name, device, mountRoot string) {
	t.Helper()
	mounter := &RealVolumeMounter{runner: runner, fstabPath: filepath.Join(t.TempDir(), "fstab")}
	err := mounter.MountVolumes(context.Background(), []VolumeMount{{
		Name:             name,
		MountRoot:        mountRoot,
		ProviderVolumeID: "vol-formatted",
		ProviderName:     "hetzner",
		LinuxDevice:      device,
		FSFormat:         "ext4",
	}})
	if err != nil {
		t.Fatalf("MountVolumes: %v", err)
	}
}

func TestRealVolumeMounter_FormatOnlyIfEmpty(t *testing.T) {
	device := writeFakeDevice(t)
	fstab := filepath.Join(t.TempDir(), "fstab")
	mountRoot := filepath.Join(t.TempDir(), "mnt")
	runner := &fakeCommandRunner{responses: map[string]cmdResponse{
		"blkid " + device:                   {err: errors.New("no filesystem")},
		"wipefs -n " + device:               {},
		"blkid -s UUID -o value " + device:  {out: "uuid-123\n"},
		"mountpoint -q " + mountRoot:        {err: errors.New("not mounted")},
		"mount " + device + " " + mountRoot: {},
	}}

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
	device := writeFakeDevice(t)
	mountRoot := filepath.Join(t.TempDir(), "mnt")
	runner := newAlreadyMountedExt4Runner(device, mountRoot)
	runner.responses["mountpoint -q "+mountRoot] = cmdResponse{err: errors.New("not mounted")}
	runner.responses["mount "+device+" "+mountRoot] = cmdResponse{}

	mountFormattedHetznerVolume(t, runner, "data", device, mountRoot)
	if runner.called("mkfs.ext4") {
		t.Fatal("existing filesystem must not be formatted")
	}
}

func TestRealVolumeMounter_RefusesWipefsSignatures(t *testing.T) {
	device := writeFakeDevice(t)
	runner := &fakeCommandRunner{responses: map[string]cmdResponse{
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
	runner := &fakeCommandRunner{responses: map[string]cmdResponse{
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

func TestRealVolumeMounter_DoesNotDiscoverDeviceByVolumeName(t *testing.T) {
	mountRoot := filepath.Join(t.TempDir(), "mnt")
	runner := &fakeCommandRunner{responses: map[string]cmdResponse{
		"lsblk -ndo PATH,SERIAL": {out: "/dev/sdb data\n"},
	}}
	mounter := &RealVolumeMounter{runner: runner, fstabPath: filepath.Join(t.TempDir(), "fstab")}
	err := mounter.MountVolumes(context.Background(), []VolumeMount{{
		Name:             "data",
		MountRoot:        mountRoot,
		ProviderVolumeID: "prov-vol-actual",
		ProviderName:     "scaleway",
		FSFormat:         "ext4",
	}})
	if err == nil || !strings.Contains(err.Error(), "no matching block device found") {
		t.Fatalf("expected provider-volume-id-only discovery failure, got %v", err)
	}
	if runner.called("mount /dev/sdb " + mountRoot) {
		t.Fatal("device matched only by volume name must not be mounted")
	}
}

func TestRealVolumeMounter_RequiresProviderVolumeIDForDiscovery(t *testing.T) {
	mounter := &RealVolumeMounter{
		runner:    &fakeCommandRunner{responses: map[string]cmdResponse{}},
		fstabPath: filepath.Join(t.TempDir(), "fstab"),
	}
	err := mounter.MountVolumes(context.Background(), []VolumeMount{{
		Name:         "data",
		MountRoot:    filepath.Join(t.TempDir(), "mnt"),
		ProviderName: "hetzner",
		FSFormat:     "ext4",
	}})
	if err == nil || !strings.Contains(err.Error(), "providerVolumeId is required") {
		t.Fatalf("expected providerVolumeId discovery error, got %v", err)
	}
}

func TestRealVolumeMounter_SkipsMountWhenAlreadyMounted(t *testing.T) {
	device := writeFakeDevice(t)
	mountRoot := filepath.Join(t.TempDir(), "mnt")
	runner := newAlreadyMountedExt4Runner(device, mountRoot)

	mountFormattedHetznerVolume(t, runner, "data", device, mountRoot)
	if runner.called("mount " + device + " " + mountRoot) {
		t.Fatal("already-mounted volume should not be mounted again")
	}
}

func TestRealVolumeMounter_CreatesWritableDataSubdirForFreshExt4LostFound(t *testing.T) {
	device := writeFakeDevice(t)
	mountRoot := filepath.Join(t.TempDir(), "mnt")
	if err := os.MkdirAll(filepath.Join(mountRoot, "lost+found"), 0700); err != nil {
		t.Fatalf("create lost+found fixture: %v", err)
	}
	runner := newAlreadyMountedExt4Runner(device, mountRoot)
	runner.responses["mountpoint -q "+mountRoot] = cmdResponse{err: errors.New("not mounted")}
	runner.responses["mount "+device+" "+mountRoot] = cmdResponse{}

	mountFormattedHetznerVolume(t, runner, "pgdata", device, mountRoot)

	dataDir := filepath.Join(mountRoot, "data")
	info, err := os.Stat(dataDir)
	if err != nil {
		t.Fatalf("stat data dir: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("expected %s to be a directory", dataDir)
	}
	if got := info.Mode().Perm(); got != 0777 {
		t.Fatalf("expected data dir mode 0777, got %03o", got)
	}
	if _, err := os.Stat(filepath.Join(mountRoot, "lost+found")); err != nil {
		t.Fatalf("lost+found fixture should remain untouched: %v", err)
	}
}

func TestRealVolumeMounter_DoesNotChmodOrClobberExistingDataSubdir(t *testing.T) {
	device := writeFakeDevice(t)
	mountRoot := filepath.Join(t.TempDir(), "mnt")
	dataDir := filepath.Join(mountRoot, "data")
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		t.Fatalf("create data dir fixture: %v", err)
	}
	sentinel := filepath.Join(dataDir, "sentinel")
	if err := os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatalf("write sentinel: %v", err)
	}
	runner := newAlreadyMountedExt4Runner(device, mountRoot)

	mountFormattedHetznerVolume(t, runner, "pgdata", device, mountRoot)

	info, err := os.Stat(dataDir)
	if err != nil {
		t.Fatalf("stat data dir: %v", err)
	}
	if got := info.Mode().Perm(); got != 0700 {
		t.Fatalf("pre-existing data dir mode should be preserved, got %03o", got)
	}
	contents, err := os.ReadFile(sentinel)
	if err != nil {
		t.Fatalf("read sentinel: %v", err)
	}
	if string(contents) != "keep" {
		t.Fatalf("sentinel contents changed: %q", contents)
	}
}

func TestRealVolumeMounter_TeardownMountsUnmountsAndRemovesFstabEntry(t *testing.T) {
	mountRoot := "/mnt/sam-env-env-1/volumes/data"
	otherRoot := "/mnt/sam-env-env-2/volumes/data"
	fstab := filepath.Join(t.TempDir(), "fstab")
	if err := os.WriteFile(
		fstab,
		[]byte("UUID=data "+mountRoot+" ext4 defaults,nofail 0 2\nUUID=other "+otherRoot+" ext4 defaults,nofail 0 2\n"),
		0644,
	); err != nil {
		t.Fatalf("write fstab: %v", err)
	}
	runner := &fakeCommandRunner{responses: map[string]cmdResponse{
		"mountpoint -q " + mountRoot: {},
		"umount " + mountRoot:        {},
	}}
	mounter := &RealVolumeMounter{runner: runner, fstabPath: fstab}

	if err := mounter.TeardownMounts(context.Background(), []string{mountRoot}); err != nil {
		t.Fatalf("TeardownMounts: %v", err)
	}

	if !runner.called("umount " + mountRoot) {
		t.Fatal("expected mounted SAM volume to be unmounted")
	}
	contents, err := os.ReadFile(fstab)
	if err != nil {
		t.Fatalf("read fstab: %v", err)
	}
	if strings.Contains(string(contents), mountRoot) {
		t.Fatalf("expected fstab entry for %s to be removed, got:\n%s", mountRoot, contents)
	}
	if !strings.Contains(string(contents), otherRoot) {
		t.Fatalf("expected unrelated fstab entry preserved, got:\n%s", contents)
	}
}

func TestRealVolumeMounter_ConcurrentFstabUpdatesPreserveEntries(t *testing.T) {
	fstab := filepath.Join(t.TempDir(), "fstab")
	mounter := &RealVolumeMounter{runner: fstabUUIDRunner{}, fstabPath: fstab}
	roots := []string{
		"/mnt/sam-env-env-1/volumes/data",
		"/mnt/sam-env-env-2/volumes/cache",
	}

	var wg sync.WaitGroup
	for i, root := range roots {
		wg.Add(1)
		go func(i int, root string) {
			defer wg.Done()
			if err := mounter.ensureFstab(context.Background(), "/dev/sd"+string(rune('b'+i)), root); err != nil {
				t.Errorf("ensureFstab(%s): %v", root, err)
			}
		}(i, root)
	}
	wg.Wait()

	contents, err := os.ReadFile(fstab)
	if err != nil {
		t.Fatalf("read fstab: %v", err)
	}
	for _, root := range roots {
		if !strings.Contains(string(contents), root) {
			t.Fatalf("expected fstab to contain %s, got:\n%s", root, contents)
		}
	}
}
