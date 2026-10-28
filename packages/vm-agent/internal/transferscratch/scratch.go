// Package transferscratch owns only disposable SAM image-transfer archives.
// It never inventories Docker, workspaces, snapshot files, or user cache trees.
package transferscratch

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	DefaultRetention             = 24 * time.Hour
	DefaultMaxEntries            = 64
	DefaultMaxFiles              = 128
	DefaultMaxReclaimBytes int64 = 1 << 30
	ownerFile                    = ".sam-transfer.json"
	leaseFile                    = ".lease"
)

type Config struct {
	Root            string
	Retention       time.Duration
	MaxEntries      int
	MaxFiles        int
	MaxReclaimBytes int64
	DryRun          bool
}

func ConfigFromEnvironment() (Config, error) {
	c := Config{Root: filepath.Join(os.TempDir(), "sam-image-transfers"), Retention: DefaultRetention, MaxEntries: DefaultMaxEntries, MaxFiles: DefaultMaxFiles, MaxReclaimBytes: DefaultMaxReclaimBytes, DryRun: true}
	if v := os.Getenv("SAM_IMAGE_TRANSFER_SCRATCH_DIR"); v != "" {
		c.Root = v
	}
	if v := os.Getenv("SAM_IMAGE_TRANSFER_SCRATCH_RETENTION"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return c, fmt.Errorf("invalid image transfer scratch retention")
		}
		c.Retention = d
	}
	for _, item := range []struct {
		name string
		dst  *int
	}{{"SAM_IMAGE_TRANSFER_SCRATCH_MAX_ENTRIES", &c.MaxEntries}, {"SAM_IMAGE_TRANSFER_SCRATCH_MAX_FILES", &c.MaxFiles}} {
		if v := os.Getenv(item.name); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n <= 0 {
				return c, fmt.Errorf("invalid %s", item.name)
			}
			*item.dst = n
		}
	}
	if v := os.Getenv("SAM_IMAGE_TRANSFER_SCRATCH_MAX_RECLAIM_BYTES"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			return c, fmt.Errorf("invalid image transfer scratch byte budget")
		}
		c.MaxReclaimBytes = n
	}
	if v := os.Getenv("SAM_IMAGE_TRANSFER_SCRATCH_DRY_RUN"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return c, fmt.Errorf("invalid image transfer scratch dry-run flag")
		}
		c.DryRun = b
	}
	return c, nil
}

type ownership struct {
	Version   int       `json:"version"`
	Directory string    `json:"directory"`
	Category  string    `json:"category"`
	CreatedAt time.Time `json:"createdAt"`
}

type Operation struct {
	Path     string
	parent   *os.Root
	root     *os.Root
	lease    *os.File
	identity os.FileInfo
	name     string
	maxFiles int
}

func ownedDirectory(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && info.IsDir() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm()&0077 == 0 && stat.Uid == uint32(os.Geteuid())
}

func openParent(path string, create bool) (*os.Root, error) {
	abs, err := filepath.Abs(path)
	if err != nil || filepath.Clean(abs) == string(filepath.Separator) {
		return nil, fmt.Errorf("unsafe scratch root")
	}
	if create {
		if err := os.MkdirAll(abs, 0700); err != nil {
			return nil, err
		}
	}
	canonical, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	if canonical != abs {
		return nil, fmt.Errorf("scratch root contains symlink")
	}
	root, err := os.OpenRoot(abs)
	if err != nil {
		return nil, err
	}
	info, err := root.Stat(".")
	if err != nil || !ownedDirectory(info) {
		root.Close()
		return nil, fmt.Errorf("scratch root ownership or permissions unknown")
	}
	return root, nil
}

// NewOperation holds an advisory file lock throughout export/download/upload/load.
// Process death releases the lock; elapsed time never overrides a live lock.
func NewOperation(category string) (*Operation, error) {
	c, err := ConfigFromEnvironment()
	if err != nil {
		return nil, err
	}
	return New(c, category)
}

func New(c Config, category string) (*Operation, error) {
	if category != "publish" && category != "deploy" {
		return nil, fmt.Errorf("unknown transfer category")
	}
	parent, err := openParent(c.Root, true)
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(c.Root, "op-"+category+"-")
	if err != nil {
		parent.Close()
		return nil, err
	}
	name := filepath.Base(dir)
	root, err := parent.OpenRoot(name)
	if err != nil {
		parent.Close()
		return nil, err
	}
	lease, err := root.OpenFile(leaseFile, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		root.Close()
		parent.Close()
		return nil, err
	}
	if err := syscall.Flock(int(lease.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lease.Close()
		root.Close()
		parent.Close()
		return nil, err
	}
	identity, err := root.Stat(".")
	if err != nil {
		lease.Close()
		root.Close()
		parent.Close()
		return nil, err
	}
	op := &Operation{Path: dir, parent: parent, root: root, lease: lease, identity: identity, name: name, maxFiles: c.MaxFiles}
	marker, err := root.OpenFile(ownerFile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		op.release()
		return nil, err
	}
	err = json.NewEncoder(marker).Encode(ownership{Version: 1, Directory: name, Category: category, CreatedAt: time.Now().UTC()})
	if err == nil {
		err = marker.Sync()
	}
	closeErr := marker.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		op.release()
		return nil, err
	}
	return op, nil
}

func (o *Operation) release() {
	if o.lease != nil {
		_ = o.lease.Close()
		o.lease = nil
	}
	if o.root != nil {
		_ = o.root.Close()
		o.root = nil
	}
	if o.parent != nil {
		_ = o.parent.Close()
		o.parent = nil
	}
}

// Close removes only this operation's flat owned files while its lease is held.
// Unexpected directories, links or mount points remain protected for inspection.
func (o *Operation) Close() error {
	if o.root == nil {
		return nil
	}
	defer o.release()
	_, err := o.remove(context.Background(), 0)
	return err
}

func regularOwned(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && info.Mode().IsRegular() && stat.Uid == uint32(os.Geteuid()) && stat.Nlink == 1
}

func (o *Operation) files() ([]os.DirEntry, int64, error) {
	if err := rejectMounts(o.root.Name()); err != nil {
		return nil, 0, err
	}
	dir, err := o.root.Open(".")
	if err != nil {
		return nil, 0, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(o.maxFiles + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, 0, err
	}
	if len(entries) > o.maxFiles {
		return nil, 0, fmt.Errorf("scratch file budget exceeded")
	}
	var bytes int64
	for _, entry := range entries {
		info, err := o.root.Lstat(entry.Name())
		if err != nil {
			return nil, 0, err
		}
		if !regularOwned(info) {
			return nil, 0, fmt.Errorf("scratch entry ownership/type unknown")
		}
		if entry.Name() != ownerFile && entry.Name() != leaseFile && !strings.HasSuffix(entry.Name(), ".tar") {
			return nil, 0, fmt.Errorf("unknown scratch file")
		}
		if info.Size() > 0 && bytes > int64(^uint64(0)>>1)-info.Size() {
			return nil, 0, fmt.Errorf("scratch size overflow")
		}
		bytes += info.Size()
	}
	return entries, bytes, nil
}

// A flat transfer directory cannot legitimately contain any mount. Check bind
// mounts too (device IDs alone miss mounts on the same filesystem).
func rejectMounts(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return fmt.Errorf("cannot verify scratch mounts: %w", err)
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	unescape := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 6 {
			return fmt.Errorf("invalid mount inventory")
		}
		mount := unescape.Replace(fields[4])
		if mount == absolute || strings.HasPrefix(mount, absolute+string(filepath.Separator)) {
			return fmt.Errorf("mounted transfer scratch is protected")
		}
	}
	return scanner.Err()
}

func (o *Operation) remove(ctx context.Context, maxBytes int64) (int64, error) {
	entries, bytes, err := o.files()
	if err != nil {
		return 0, err
	}
	if maxBytes > 0 && bytes > maxBytes {
		return 0, fmt.Errorf("scratch byte budget exceeded")
	}
	current, err := o.parent.Lstat(o.name)
	if err != nil || !os.SameFile(o.identity, current) {
		return 0, fmt.Errorf("scratch directory identity changed")
	}
	// No recursive removal: a directory or file bind mount cannot be traversed.
	// The kernel rejects removing mounted files, leaving a retryable directory.
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		if entry.Name() == ownerFile || entry.Name() == leaseFile {
			continue
		}
		if err := o.root.Remove(entry.Name()); err != nil {
			return 0, err
		}
	}
	if err := o.root.Remove(ownerFile); err != nil && !os.IsNotExist(err) {
		return 0, err
	}
	if err := o.root.Remove(leaseFile); err != nil && !os.IsNotExist(err) {
		return 0, err
	}
	if err := o.parent.Remove(o.name); err != nil {
		return 0, err
	}
	return bytes, nil
}

type Report struct {
	Scanned, Candidates, Protected, Removed int
	CandidateBytes, ReclaimedBytes          int64
	Truncated                               bool
	DryRun                                  bool
}

// A bounded directory iterator continues across sweeps instead of starving
// later entries behind a large collection of protected active operations.
var scanState struct {
	sync.Mutex
	path string
	dir  *os.File
}

func SweepFromEnvironment(ctx context.Context) {
	c, err := ConfigFromEnvironment()
	if err != nil {
		slog.Warn("image_transfer_scratch.config_invalid", "error", err)
		return
	}
	r, err := Sweep(ctx, c, time.Now())
	if err != nil {
		slog.Warn("image_transfer_scratch.sweep_failed", "error", err)
		return
	}
	if r.Scanned > 0 {
		slog.Info("image_transfer_scratch.inventory", "report", r)
	}
}

func Sweep(ctx context.Context, c Config, now time.Time) (Report, error) {
	r := Report{DryRun: c.DryRun}
	if c.MaxEntries <= 0 || c.MaxFiles <= 0 || c.MaxReclaimBytes <= 0 || c.Retention <= 0 {
		return r, fmt.Errorf("invalid scratch cleanup budget")
	}
	parent, err := openParent(c.Root, false)
	if os.IsNotExist(err) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	defer parent.Close()
	scanState.Lock()
	defer scanState.Unlock()
	if scanState.path != c.Root && scanState.dir != nil {
		scanState.dir.Close()
		scanState.dir = nil
	}
	if scanState.dir != nil {
		oldInfo, oldErr := scanState.dir.Stat()
		newInfo, newErr := parent.Stat(".")
		if oldErr != nil || newErr != nil || !os.SameFile(oldInfo, newInfo) {
			scanState.dir.Close()
			scanState.dir = nil
		}
	}
	if scanState.dir == nil {
		scanState.dir, err = parent.Open(".")
		if err != nil {
			return r, err
		}
		scanState.path = c.Root
	}
	entries, readErr := scanState.dir.ReadDir(c.MaxEntries)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		scanState.dir.Close()
		scanState.dir = nil
		return r, readErr
	}
	if len(entries) < c.MaxEntries {
		scanState.dir.Close()
		scanState.dir = nil
	} else {
		r.Truncated = true
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return r, err
		}
		r.Scanned++
		op, createdAt, err := inspect(parent, c, entry.Name())
		if err != nil {
			r.Protected++
			continue
		}
		func() {
			defer op.release()
			if createdAt.After(now) || now.Sub(createdAt) < c.Retention {
				r.Protected++
				return
			}
			_, bytes, err := op.files()
			if err != nil {
				r.Protected++
				return
			}
			if bytes > c.MaxReclaimBytes-r.CandidateBytes {
				r.Truncated = true
				r.Protected++
				return
			}
			r.Candidates++
			r.CandidateBytes += bytes
			if c.DryRun {
				return
			}
			reclaimed, err := op.remove(ctx, c.MaxReclaimBytes-r.ReclaimedBytes)
			if err != nil {
				r.Protected++
				return
			}
			r.Removed++
			r.ReclaimedBytes += reclaimed
		}()
	}
	return r, nil
}

func inspect(parent *os.Root, c Config, name string) (*Operation, time.Time, error) {
	if !strings.HasPrefix(name, "op-publish-") && !strings.HasPrefix(name, "op-deploy-") {
		return nil, time.Time{}, fmt.Errorf("unknown scratch directory")
	}
	identity, err := parent.Lstat(name)
	if err != nil || !ownedDirectory(identity) {
		return nil, time.Time{}, fmt.Errorf("unknown scratch directory ownership")
	}
	root, err := parent.OpenRoot(name)
	if err != nil {
		return nil, time.Time{}, err
	}
	openedInfo, err := root.Stat(".")
	if err != nil || !os.SameFile(identity, openedInfo) {
		root.Close()
		return nil, time.Time{}, fmt.Errorf("scratch directory changed while opening")
	}
	leaseInfo, err := root.Lstat(leaseFile)
	if err != nil || !regularOwned(leaseInfo) {
		root.Close()
		return nil, time.Time{}, fmt.Errorf("unknown lease file")
	}
	lease, err := root.OpenFile(leaseFile, os.O_RDWR, 0)
	if err != nil {
		root.Close()
		return nil, time.Time{}, err
	}
	if err := syscall.Flock(int(lease.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lease.Close()
		root.Close()
		return nil, time.Time{}, err
	}
	openedLease, err := lease.Stat()
	if err != nil || !os.SameFile(leaseInfo, openedLease) {
		lease.Close()
		root.Close()
		return nil, time.Time{}, fmt.Errorf("scratch lease identity changed")
	}
	// Open a separate parent handle so releasing an operation cannot close the
	// sweep's own directory capability.
	parentCopy, err := parent.OpenRoot(".")
	if err != nil {
		lease.Close()
		root.Close()
		return nil, time.Time{}, err
	}
	op := &Operation{parent: parentCopy, root: root, lease: lease, identity: identity, name: name, maxFiles: c.MaxFiles}
	markerInfo, err := root.Lstat(ownerFile)
	if err != nil || !regularOwned(markerInfo) {
		op.release()
		return nil, time.Time{}, fmt.Errorf("missing ownership marker")
	}
	marker, err := root.Open(ownerFile)
	if err != nil {
		op.release()
		return nil, time.Time{}, err
	}
	var owner ownership
	err = json.NewDecoder(io.LimitReader(marker, 4096)).Decode(&owner)
	marker.Close()
	if err != nil || owner.Version != 1 || owner.Directory != name || (owner.Category != "publish" && owner.Category != "deploy") || !strings.HasPrefix(name, "op-"+owner.Category+"-") || owner.CreatedAt.IsZero() {
		op.release()
		return nil, time.Time{}, fmt.Errorf("invalid ownership marker")
	}
	return op, owner.CreatedAt, nil
}
