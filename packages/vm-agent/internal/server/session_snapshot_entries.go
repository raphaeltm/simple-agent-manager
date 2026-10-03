package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// defaultSnapshotJSONBodyMaxBytes mirrors the control plane's
// SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES default for a prepare response that does
// not report config.jsonBodyMaxBytes.
const defaultSnapshotJSONBodyMaxBytes int64 = 256 * 1024

// snapshotSkippedTextShare caps a single skipped entry's path or reason at this
// fraction of the skipped-entry budget, so one long error cannot crowd out the
// rest of the list.
const snapshotSkippedTextShare = 16

// snapshotSkippedSummaryReserve is room kept for the summary entry that records
// how many skipped entries were folded away.
const snapshotSkippedSummaryReserve = 256

// snapshotSkippedSummaryPath identifies the summary entry in a bounded list.
const snapshotSkippedSummaryPath = "snapshot-skipped-entries"

// snapshotGitInputCommand runs git with the given stdin and returns its stdout.
type snapshotGitInputCommand func(ctx context.Context, env []string, input []byte, args ...string) (string, error)

func standaloneSnapshotGitWithInput(workDir string) snapshotGitInputCommand {
	return func(ctx context.Context, env []string, input []byte, args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, standaloneGitBinaryPath, args...)
		cmd.Dir = workDir
		if len(env) > 0 {
			cmd.Env = append(os.Environ(), env...)
		}
		return runSnapshotGitWithInput(cmd, input, args)
	}
}

func (s *Server) containerSnapshotGitWithInput(target *containerSnapshotTarget) snapshotGitInputCommand {
	return func(ctx context.Context, env []string, input []byte, args ...string) (string, error) {
		cmd, err := s.workspaceExecCommandWithEnv(ctx, target.containerID, target.user, target.workDir, env, append([]string{"git"}, args...)...)
		if err != nil {
			return "", err
		}
		return runSnapshotGitWithInput(cmd, input, args)
	}
}

func runSnapshotGitWithInput(cmd *exec.Cmd, input []byte, args []string) (string, error) {
	var stdout, stderr bytes.Buffer
	cmd.Stdin = bytes.NewReader(input)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s failed: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

type snapshotIndexEntry struct {
	object string
	path   string
}

// parseSnapshotIndexEntries parses `git ls-files -s -z` output, whose records
// are NUL-separated "<mode> <object> <stage>\t<path>", dropping excluded paths.
func parseSnapshotIndexEntries(output string, excluded map[string]bool) []snapshotIndexEntry {
	var entries []snapshotIndexEntry
	for _, record := range strings.Split(output, "\x00") {
		meta, path, found := strings.Cut(record, "\t")
		fields := strings.Fields(meta)
		if !found || path == "" || len(fields) < 2 {
			continue
		}
		path = filepath.ToSlash(filepath.Clean(path))
		if excluded[path] {
			continue
		}
		entries = append(entries, snapshotIndexEntry{object: fields[1], path: path})
	}
	return entries
}

// oversizedSnapshotIndexEntries returns, in index order, the entries whose
// object is larger than threshold. All sizes come from one
// `git cat-file --batch-check`. The per-entry `git cat-file -s` this replaced
// cost one process per tracked file, and one `docker exec` per file inside a
// devcontainer: about ten minutes for the SAM repository's 7,086 files with no
// progress callback, which tripped the control plane's two-minute
// final-snapshot watchdog. Objects git cannot find, such as submodule gitlinks,
// are treated as not oversized, as before.
func oversizedSnapshotIndexEntries(ctx context.Context, git snapshotGitInputCommand, entries []snapshotIndexEntry, threshold int64, reason string) ([]snapshotSkippedEntry, error) {
	if len(entries) == 0 {
		return nil, nil
	}
	var input strings.Builder
	requested := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if !requested[entry.object] {
			requested[entry.object] = true
			input.WriteString(entry.object)
			input.WriteByte('\n')
		}
	}
	output, err := git(ctx, nil, []byte(input.String()), "cat-file", "--batch-check=%(objectname) %(objectsize)")
	if err != nil {
		return nil, err
	}
	sizes := make(map[string]int64, len(requested))
	for _, line := range strings.Split(output, "\n") {
		object, rawSize, found := strings.Cut(strings.TrimSpace(line), " ")
		if !found {
			continue
		}
		// "<object> missing" fails the parse and is skipped.
		if size, parseErr := strconv.ParseInt(rawSize, 10, 64); parseErr == nil {
			sizes[object] = size
		}
	}
	var skipped []snapshotSkippedEntry
	for _, entry := range entries {
		if size, ok := sizes[entry.object]; ok && size > threshold {
			skipped = append(skipped, snapshotSkippedEntry{Path: entry.path, Reason: reason, SizeBytes: size})
		}
	}
	return skipped, nil
}

// snapshotSkippedEntriesBudget is the share of the control plane's JSON body
// limit the skipped list may use, leaving the rest for the manifest's other
// fields and the request envelope.
func snapshotSkippedEntriesBudget(prepare *snapshotPrepareResponse) int64 {
	return choosePositiveInt64(prepare.Config.JSONBodyMaxBytes, defaultSnapshotJSONBodyMaxBytes) / 2
}

// boundSnapshotSkippedEntries keeps the snapshot completion request within the
// control plane's JSON body limit. The manifest records one entry per skipped
// file, so a HOME that overflowed the snapshot budget produced thousands of
// entries. The control plane then rejected the request with 400 "Snapshot
// request body is too large", and the capture never completed (54 workspaces
// by 2026-10-03).
//
// Entries without a size (capture failures and other diagnostics) are kept
// first, then the largest files. Long text is truncated, and the remainder is
// folded into one summary entry so the omission stays visible.
func boundSnapshotSkippedEntries(entries []snapshotSkippedEntry, maxBytes int64) []snapshotSkippedEntry {
	if maxBytes <= 0 || snapshotSkippedJSONSize(entries) <= maxBytes {
		return entries
	}
	ordered := append([]snapshotSkippedEntry(nil), entries...)
	sort.SliceStable(ordered, func(i, j int) bool {
		leftDiagnostic, rightDiagnostic := ordered[i].SizeBytes == 0, ordered[j].SizeBytes == 0
		if leftDiagnostic != rightDiagnostic {
			return leftDiagnostic
		}
		return ordered[i].SizeBytes > ordered[j].SizeBytes
	})
	textLimit := int(maxBytes / snapshotSkippedTextShare)
	used := int64(len("[]")) + snapshotSkippedSummaryReserve
	kept := make([]snapshotSkippedEntry, 0, len(ordered))
	var omitted int
	var omittedBytes int64
	for _, entry := range ordered {
		entry.Path = truncateSnapshotText(entry.Path, textLimit)
		entry.Reason = truncateSnapshotText(entry.Reason, textLimit)
		size := snapshotSkippedJSONSize([]snapshotSkippedEntry{entry}) - int64(len("[]")) + int64(len(","))
		if used+size > maxBytes {
			omitted++
			omittedBytes += entry.SizeBytes
			continue
		}
		kept = append(kept, entry)
		used += size
	}
	if omitted > 0 {
		kept = append(kept, snapshotSkippedEntry{
			Path:      snapshotSkippedSummaryPath,
			Reason:    fmt.Sprintf("%d more skipped entries omitted to fit the snapshot completion request", omitted),
			SizeBytes: omittedBytes,
		})
	}
	return kept
}

func snapshotSkippedJSONSize(entries []snapshotSkippedEntry) int64 {
	encoded, err := json.Marshal(entries)
	if err != nil {
		return 0
	}
	return int64(len(encoded))
}

func truncateSnapshotText(value string, limit int) string {
	const marker = "..."
	if limit <= len(marker) || len(value) <= limit {
		return value
	}
	cut := limit - len(marker)
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut] + marker
}
