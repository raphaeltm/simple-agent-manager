// Package contextcollect collects portable Compose inputs without Docker.
package contextcollect

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/klauspost/compress/zstd"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	DEFAULT_BUILD_CONTEXT_MAX_BYTES          int64 = 2 * 1024 * 1024 * 1024
	DEFAULT_BUILD_CONTEXT_COLLECT_TIMEOUT_MS       = 120000
	SecretPlaceholder                              = "__SAM_CONFIGURED_SECRET_PLACEHOLDER__"
)

type Options struct {
	// Root is an already-open directory capability. The caller must obtain it
	// from a trusted base with Root.OpenRoot and owns its lifetime.
	Root       *os.Root
	BuildEnv   map[string]string
	SecretKeys []string
	MaxBytes   int64
	Timeout    time.Duration
}
type Result struct {
	Bytes      int64  `json:"sizeBytes"`
	SHA256     string `json:"sha256"`
	DurationMs int64  `json:"durationMs"`
}
type budgetWriter struct {
	ctx    context.Context
	w      io.Writer
	max, n int64
}

func (w *budgetWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	if int64(len(p)) > w.max-w.n {
		return 0, fmt.Errorf("build context exceeds maximum %d bytes; reduce inputs with .dockerignore or raise the context size setting", w.max)
	}
	n, err := w.w.Write(p)
	w.n += int64(n)
	return n, err
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

// Collect bounds raw tar metadata/payload and compressed output. Callers spool
// privately before requesting an upload, so rejection never uploads a prefix.
func Collect(parent context.Context, opts Options, output io.Writer) (*Result, error) {
	started := time.Now()
	if opts.MaxBytes <= 0 {
		opts.MaxBytes = DEFAULT_BUILD_CONTEXT_MAX_BYTES
	}
	if opts.Timeout <= 0 {
		opts.Timeout = time.Duration(DEFAULT_BUILD_CONTEXT_COLLECT_TIMEOUT_MS) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(parent, opts.Timeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if opts.Root == nil {
		return nil, fmt.Errorf("an open source root is required")
	}
	// This string is only a Compose path label. Source IO always uses Root.
	root, err := filepath.Abs(opts.Root.Name())
	if err != nil {
		return nil, err
	}
	plan, err := makePlan(ctx, opts)
	if err != nil {
		return nil, err
	}
	safe := opts.Root
	hash := sha256.New()
	compressed := &budgetWriter{ctx: ctx, w: io.MultiWriter(output, hash), max: opts.MaxBytes}
	encoder, err := zstd.NewWriter(compressed, zstd.WithEncoderConcurrency(1))
	if err != nil {
		return nil, err
	}
	defer encoder.Close()
	tw := tar.NewWriter(&budgetWriter{ctx: ctx, w: encoder, max: opts.MaxBytes})
	err = fs.WalkDir(rootWalkFS{root: safe}, ".", func(rel string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		path := filepath.Join(root, filepath.FromSlash(rel))
		needed, err := plan.includes(path)
		if err != nil {
			return err
		}
		if !needed && d.IsDir() && !plan.descends(path) {
			return fs.SkipDir
		}
		if !needed {
			return nil
		}
		return writeEntry(ctx, tw, safe, plan, path, rel)
	})
	if err != nil {
		return nil, err
	}
	for path := range plan.empty {
		if _, err := plan.lstat(path); os.IsNotExist(err) {
			rel, _ := filepath.Rel(root, path)
			if err := tw.WriteHeader(&tar.Header{Name: filepath.ToSlash(rel), Mode: 0600, Typeflag: tar.TypeReg}); err != nil {
				return nil, err
			}
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := encoder.Close(); err != nil {
		return nil, err
	}
	return &Result{Bytes: compressed.n, SHA256: hex.EncodeToString(hash.Sum(nil)), DurationMs: time.Since(started).Milliseconds()}, nil
}
func writeEntry(ctx context.Context, tw *tar.Writer, safe *os.Root, plan *collectionPlan, path, rel string) error {
	if err := plan.validatePath(path); err != nil {
		return err
	}
	info, err := safe.Lstat(rel)
	if err != nil {
		return err
	}
	link := ""
	if info.Mode()&os.ModeSymlink != 0 {
		link, err = safe.Readlink(rel)
		if err != nil {
			return err
		}
		if !within(plan.root, filepath.Join(filepath.Dir(path), link)) {
			return fmt.Errorf("symlink %s escapes working directory", rel)
		}

		if filepath.IsAbs(link) {
			return fmt.Errorf("absolute symlink %s is not portable; use a relative link", rel)
		}
	}
	if !info.Mode().IsRegular() && !info.IsDir() && link == "" {
		return fmt.Errorf("unsupported special file %s; remove it from build inputs", rel)
	}
	// Open before emitting metadata, then retain the descriptor through copying.
	// A rename/symlink swap cannot change which inode supplies the payload.
	var file *os.File
	if info.Mode().IsRegular() && !plan.isSensitive(path, info) {
		file, err = plan.open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		opened, err := file.Stat()
		if err != nil {
			return err
		}
		if !os.SameFile(info, opened) {
			return fmt.Errorf("file %s changed while collecting; retry", rel)
		}
		info = opened
	}
	h, err := tar.FileInfoHeader(info, link)
	if err != nil {
		return err
	}
	h.Name = filepath.ToSlash(rel)
	h.Uid = 0
	h.Gid = 0
	h.Uname = ""
	h.Gname = ""
	if plan.isSensitive(path, info) {
		h.Typeflag = tar.TypeReg
		h.Linkname = ""
		h.Size = 0
		h.Mode = 0600
	}
	if err := tw.WriteHeader(h); err != nil {
		return err
	}
	if h.Typeflag != tar.TypeReg || h.Size == 0 {
		return nil
	}
	n, err := io.Copy(tw, &contextReader{ctx: ctx, r: io.LimitReader(file, h.Size)})
	if err != nil {
		return err
	}
	if n != h.Size {
		return fmt.Errorf("file %s changed while collecting; retry", rel)
	}
	return nil
}
func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// Resolve each component before consuming '..', including dangling links.
// EvalSymlinks alone loses the escape evidence when the target is missing.
func (p *collectionPlan) resolvePath(path string) (string, error) {
	root := p.root
	if !within(root, path) {
		return "", fmt.Errorf("path %s escapes working directory; move inputs under %s", path, root)
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return "", err
	}
	parts := strings.Split(rel, string(filepath.Separator))
	current := root
	seen := map[string]bool{}
	for len(parts) > 0 {
		part := parts[0]
		parts = parts[1:]
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			current = filepath.Dir(current)
			if !within(root, current) {
				return "", fmt.Errorf("symlink %s escapes working directory", path)
			}
			continue
		}
		next := filepath.Join(current, part)
		info, err := p.lstat(next)
		if os.IsNotExist(err) {
			current = next
			continue
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			current = next
			continue
		}
		if seen[next] {
			return "", fmt.Errorf("cyclic symlink %s in build inputs", path)
		}
		seen[next] = true
		rel, err := p.relative(next)
		if err != nil {
			return "", err
		}
		target, err := p.source.Readlink(rel)
		if err != nil {
			return "", err
		}
		if filepath.IsAbs(target) {
			if !within(root, target) {
				return "", fmt.Errorf("symlink %s escapes working directory", path)
			}
			target, err = filepath.Rel(root, target)
			if err != nil {
				return "", err
			}
			current = root
		}
		parts = append(strings.Split(target, string(filepath.Separator)), parts...)
	}
	return current, nil
}
