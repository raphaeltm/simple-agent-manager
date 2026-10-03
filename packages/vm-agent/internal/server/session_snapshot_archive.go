package server

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const snapshotExternalRootsPrefix = ".sam-snapshot-roots"

const (
	snapshotRootCodex    = "codex"
	snapshotRootClaude   = "claude"
	snapshotRootOpenCode = "opencode"
)

type snapshotArchiveRoot struct {
	logicalName string
	path        string
}

func createHomeTar(homeDirFn func() (string, error), entryThreshold, totalBudget int64) (string, []snapshotSkippedEntry, error) {
	return createSessionStateTarWithContext(context.Background(), homeDirFn, entryThreshold, totalBudget, false, nil)
}

// createSessionStateTar archives HOME plus any harness state root configured
// outside HOME. External source paths are never serialized: they are mapped to
// a fixed logical namespace and resolved again from the fresh runtime on restore.
func createSessionStateTar(homeDirFn func() (string, error), entryThreshold, totalBudget int64, includeExternalRoots bool) (string, []snapshotSkippedEntry, error) {
	return createSessionStateTarWithContext(context.Background(), homeDirFn, entryThreshold, totalBudget, includeExternalRoots, nil)
}

func createSessionStateTarWithContext(
	ctx context.Context,
	homeDirFn func() (string, error),
	entryThreshold, totalBudget int64,
	includeExternalRoots bool,
	reportProgress func(context.Context, string),
) (string, []snapshotSkippedEntry, error) {
	home, err := homeDirFn()
	if err != nil {
		return "", nil, err
	}
	home = filepath.Clean(home)
	roots := []snapshotArchiveRoot{{path: home}}
	if includeExternalRoots {
		externalRoots, rootsErr := resolveLocalExternalSnapshotRoots(home)
		if rootsErr != nil {
			return "", nil, rootsErr
		}
		roots = append(roots, externalRoots...)
	}
	out, err := os.CreateTemp("", "sam-session-home-*.tar")
	if err != nil {
		return "", nil, err
	}
	path := out.Name()
	tw := tar.NewWriter(out)
	var written int64
	var entryCount int
	var skipped []snapshotSkippedEntry
	var walkErr error
	for _, root := range roots {
		if walkErr != nil {
			break
		}
		if err := ctx.Err(); err != nil {
			walkErr = err
			break
		}
		info, statErr := os.Lstat(root.path)
		if os.IsNotExist(statErr) {
			continue
		}
		if statErr != nil {
			walkErr = statErr
			break
		}
		if !info.IsDir() {
			walkErr = fmt.Errorf("snapshot state root %q is not a directory", root.logicalName)
			break
		}
		walkErr = filepath.WalkDir(root.path, func(path string, d os.DirEntry, walkPathErr error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if reportProgress != nil {
				reportProgress(ctx, "home-walk")
			}
			if walkPathErr != nil || path == root.path {
				return walkPathErr
			}
			rel, relErr := filepath.Rel(root.path, path)
			if relErr != nil {
				return relErr
			}
			if shouldExcludeSnapshotRootPath(root.logicalName, rel) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			entryInfo, entryErr := d.Info()
			if entryErr != nil {
				return entryErr
			}
			displayPath := snapshotDisplayPath(root.logicalName, rel)
			if entryInfo.Size() > entryThreshold {
				skipped = append(skipped, snapshotSkippedEntry{Path: displayPath, Reason: "entry exceeds size threshold", SizeBytes: entryInfo.Size()})
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if !entryInfo.Mode().IsRegular() && !entryInfo.IsDir() {
				skipped = append(skipped, snapshotSkippedEntry{Path: displayPath, Reason: "unsupported home entry type"})
				return nil
			}
			if !entryInfo.IsDir() && written+entryInfo.Size() > totalBudget {
				skipped = append(skipped, snapshotSkippedEntry{Path: displayPath, Reason: "snapshot budget exhausted", SizeBytes: entryInfo.Size()})
				return nil
			}
			entryCount++
			if entryCount > defaultSnapshotMaxArchiveEntries {
				return fmt.Errorf("snapshot HOME archive exceeds entry limit")
			}
			header, headerErr := tar.FileInfoHeader(entryInfo, "")
			if headerErr != nil {
				return headerErr
			}
			header.Name = snapshotArchiveName(root.logicalName, rel)
			if err := tw.WriteHeader(header); err != nil {
				return err
			}
			if entryInfo.Mode().IsRegular() {
				f, openErr := os.Open(path)
				if openErr != nil {
					return openErr
				}
				n, copyErr := copySnapshotFileWithContext(ctx, tw, f, func() {
					if reportProgress != nil {
						reportProgress(ctx, "home-copy")
					}
				})
				closeErr := f.Close()
				written += n
				if copyErr != nil {
					return copyErr
				}
				if closeErr != nil {
					return closeErr
				}
			}
			return nil
		})
	}
	closeErr := tw.Close()
	fileCloseErr := out.Close()
	if walkErr != nil || closeErr != nil || fileCloseErr != nil {
		_ = os.Remove(path)
		if walkErr != nil {
			return "", skipped, walkErr
		}
		if closeErr != nil {
			return "", skipped, closeErr
		}
		return "", skipped, fileCloseErr
	}
	if _, err := validateSnapshotHomeTar(path, entryThreshold, totalBudget); err != nil {
		_ = os.Remove(path)
		return "", skipped, fmt.Errorf("validate generated HOME archive: %w", err)
	}
	return path, skipped, nil
}

func copySnapshotFileWithContext(ctx context.Context, dst io.Writer, src io.Reader, reportProgress func()) (int64, error) {
	buf := make([]byte, 1024*1024)
	var written int64
	for {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		nr, readErr := src.Read(buf)
		if nr > 0 {
			nw, writeErr := dst.Write(buf[:nr])
			written += int64(nw)
			if reportProgress != nil {
				reportProgress()
			}
			if writeErr != nil {
				return written, writeErr
			}
			if nw != nr {
				return written, io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}

func resolveLocalExternalSnapshotRoots(home string) ([]snapshotArchiveRoot, error) {
	candidates, err := externalSnapshotRootCandidates(home, os.Getenv)
	if err != nil {
		return nil, err
	}
	var roots []snapshotArchiveRoot
	for _, candidate := range candidates {
		if candidate.path == "" {
			continue
		}
		candidate.path = filepath.Clean(candidate.path)
		if !filepath.IsAbs(candidate.path) || pathWithinRoot(home, candidate.path) {
			continue
		}
		roots = append(roots, candidate)
	}
	return roots, nil
}

func externalSnapshotRootCandidates(home string, getenv func(string) string) ([]snapshotArchiveRoot, error) {
	dataHome := strings.TrimSpace(getenv("XDG_DATA_HOME"))
	if dataHome == "" {
		dataHome = filepath.Join(home, ".local", "share")
	}
	candidates := []snapshotArchiveRoot{
		{logicalName: snapshotRootCodex, path: strings.TrimSpace(getenv("CODEX_HOME"))},
		{logicalName: snapshotRootClaude, path: strings.TrimSpace(getenv("CLAUDE_CONFIG_DIR"))},
		{logicalName: snapshotRootOpenCode, path: filepath.Join(dataHome, "opencode")},
	}
	for index := range candidates {
		candidate := &candidates[index]
		if candidate.path == "" {
			continue
		}
		candidate.path = filepath.Clean(candidate.path)
		if !filepath.IsAbs(candidate.path) || candidate.path == string(filepath.Separator) {
			return nil, fmt.Errorf("unsafe %s snapshot state root %q", candidate.logicalName, candidate.path)
		}
	}
	return candidates, nil
}

func pathWithinRoot(root, candidate string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func snapshotArchiveName(logicalName, rel string) string {
	rel = filepath.ToSlash(filepath.Clean(rel))
	if logicalName == "" {
		return rel
	}
	return snapshotExternalRootsPrefix + "/" + logicalName + "/" + rel
}

func snapshotDisplayPath(logicalName, rel string) string {
	if logicalName == "" {
		return "~/" + filepath.ToSlash(rel)
	}
	return "$" + strings.ToUpper(logicalName) + "_STATE/" + filepath.ToSlash(rel)
}

func shouldExcludeSnapshotRootPath(logicalName, rel string) bool {
	clean := filepath.ToSlash(filepath.Clean(rel))
	if logicalName == "" {
		return shouldExcludeHomePath(clean)
	}
	for _, prefix := range snapshotRootExcludePrefixes[logicalName] {
		if clean == prefix || strings.HasPrefix(clean, prefix+"/") {
			return true
		}
	}
	return snapshotRootExcludeFiles[logicalName][clean]
}

var snapshotRootExcludePrefixes = map[string][]string{
	snapshotRootCodex:    {"tmp"},
	snapshotRootClaude:   {"debug"},
	snapshotRootOpenCode: {"cache"},
}

var snapshotRootExcludeFiles = map[string]map[string]bool{
	snapshotRootCodex: {
		"auth.json":   true,
		"config.toml": true,
	},
	snapshotRootClaude: {
		".credentials.json": true,
		"credentials.json":  true,
	},
	snapshotRootOpenCode: {
		"auth.json":        true,
		"credentials.json": true,
		"providers.json":   true,
	},
}

// homeExcludePrefixes are HOME-relative path prefixes whose entire subtree is
// excluded from the snapshot tar. Two kinds live here: bulky re-provisioned
// caches (safe to drop) and credential-bearing paths that MUST never reach R2
// (the HOME tar is uploaded to 7-day R2 storage). Restore re-provisions all
// credentials fresh from the control plane, so excluding them is lossless.
// Matched on whole path segments: ".ssh" excludes ".ssh" and ".ssh/id_ed25519"
// but not ".sshfoo" or ".config/gh-other".
var homeExcludePrefixes = []string{
	// Caches — bulky, re-fetchable.
	".cache", ".npm", ".cargo", ".rustup", ".local/bin", ".local/lib", "node_modules", ".docker",
	".codex/tmp", ".claude/debug", ".oh-my-zsh", ".vscode-server",
	"go/pkg", ".local/share/pnpm", ".nvm", ".bun/install/cache", ".gradle", ".m2",
	// Native Claude executables are reinstalled; resumable state lives in .claude.
	".local/share/claude/versions",
	// Credential-bearing paths — plaintext secrets must never be uploaded.
	".ssh", ".aws", ".netrc", ".npmrc", ".config/gh", ".kube", ".azure", ".config/gcloud",
	// Reserved snapshot namespace. HOME content must never be able to masquerade
	// as a control-plane-selected external harness root.
	snapshotExternalRootsPrefix,
}

// homeExcludeFiles are exact HOME-relative files excluded from the tar. Their
// parent directories (.claude, .codex) ALSO hold harness transcript/session
// state that LoadSession-resume depends on, so only the credential file itself
// is dropped — never the whole directory.
var homeExcludeFiles = map[string]bool{
	".claude/.credentials.json": true,
	".codex/auth.json":          true,
	// Generated runtime configuration can contain callback-token URLs (Codex)
	// or literal MCP bearer tokens and header values (Vibe). It is regenerated
	// from fresh control-plane credentials before the restored harness is loaded.
	".codex/config.toml": true,
	".vibe/config.toml":  true,
	".git-credentials":   true,
	".pypirc":            true,
}

func shouldExcludeHomePath(rel string) bool {
	clean := filepath.ToSlash(rel)
	if homeExcludeFiles[clean] {
		return true
	}
	for _, prefix := range homeExcludePrefixes {
		if clean == prefix || strings.HasPrefix(clean, prefix+"/") {
			return true
		}
	}
	return false
}

func rejectSymlinkPath(root, target string) error {
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("snapshot target is outside home")
	}
	current := root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, statErr := os.Lstat(current)
		if os.IsNotExist(statErr) {
			continue
		}
		if statErr != nil {
			return statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("snapshot target traverses symlink: %s", rel)
		}
	}
	return nil
}
