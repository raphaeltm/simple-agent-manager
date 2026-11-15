package bootstrap

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
)

const gitCredentialExchangeTokenBytes = 32

// NewGitCredentialExchangeToken creates the dedicated bearer embedded in one
// workspace's mounted Git credential helper.
func NewGitCredentialExchangeToken() (string, error) {
	random := make([]byte, gitCredentialExchangeTokenBytes)
	if _, err := io.ReadFull(rand.Reader, random); err != nil {
		return "", fmt.Errorf("generate git credential exchange token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(random), nil
}

// gitCredentialHelperScriptMaxBytes bounds how much of an existing helper file
// is read when looking for a reusable exchange token. Rendered helpers are a
// few KiB; anything larger is not one of ours.
const gitCredentialHelperScriptMaxBytes = 64 << 10

// gitCredentialExchangeTokenLinePrefix is the shell assignment both the node
// and the standalone helper templates use to embed the exchange bearer.
const gitCredentialExchangeTokenLinePrefix = "exchange_token="

// InstallGitCredentialExchange retains only a SHA-256 digest on the VM host.
// Install it after the helper script is in place so a failed replacement does
// not revoke the previous running helper.
func InstallGitCredentialExchange(workspaceID, token string) error {
	workspaceID = strings.TrimSpace(workspaceID)
	token = strings.TrimSpace(token)
	if workspaceID == "" || token == "" {
		return fmt.Errorf("workspace id and token are required for git credential exchange")
	}
	digest := sha256.Sum256([]byte(token))
	return writeGitCredentialExchangeDigest(workspaceID, digest[:])
}

// ValidateGitCredentialExchange checks a presented workspace bearer against
// the owner-only digest retained on the VM host.
func ValidateGitCredentialExchange(workspaceID, token string) bool {
	workspaceID = strings.TrimSpace(workspaceID)
	token = strings.TrimSpace(token)
	if workspaceID == "" || token == "" {
		return false
	}

	f, err := os.OpenFile(gitCredentialExchangeDigestPath(workspaceID), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return false
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || !ownedByCurrentUser(info) {
		return false
	}
	encoded, err := io.ReadAll(io.LimitReader(f, sha256.Size*2+1))
	if err != nil || len(encoded) != sha256.Size*2 {
		return false
	}
	expected := make([]byte, sha256.Size)
	if _, err := hex.Decode(expected, encoded); err != nil {
		return false
	}
	actual := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(actual[:], expected) == 1
}

// ExchangeTokenFromHelperScript returns the exchange bearer embedded in a
// rendered credential helper, or "" when the script carries none (for example a
// helper written by an agent build that predates the exchange bearer).
func ExchangeTokenFromHelperScript(script string) string {
	for _, line := range strings.Split(script, "\n") {
		line = strings.TrimSpace(line)
		value, ok := strings.CutPrefix(line, gitCredentialExchangeTokenLinePrefix)
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
			value = value[1 : len(value)-1]
		}
		if value == "" || strings.ContainsAny(value, "'\"\\ \t$`") {
			return ""
		}
		return value
	}
	return ""
}

// ResolveGitCredentialExchangeToken returns the exchange bearer to embed in a
// workspace's helper. It reuses the bearer of the existing helper at helperPath
// while that bearer still validates against the workspace's installed digest,
// and mints a new one otherwise; reused reports which.
//
// Reuse keeps the bearer stable for the workspace's lifetime. A running
// devcontainer holds its helper through a single-file bind mount, which pins the
// inode it was started with, so a reprovision (rebuild, restart, recovery,
// snapshot restore) that rotated the bearer would leave the container presenting
// a bearer the digest no longer accepts, and every fetch and push would fail.
//
// When the digest itself is gone (a /tmp cleaner, a partial cleanup) but the
// helper this agent wrote still holds a bearer, the digest is reinstalled from
// that bearer rather than rotating it under a running container. A digest that
// exists and does not match is never overridden: something rotated it on purpose.
func ResolveGitCredentialExchangeToken(workspaceID, helperPath string) (token string, reused bool, err error) {
	existing := readHelperExchangeToken(helperPath)
	if existing != "" && ValidateGitCredentialExchange(workspaceID, existing) {
		return existing, true, nil
	}
	if existing != "" && gitCredentialExchangeDigestMissing(workspaceID) {
		if err := InstallGitCredentialExchange(workspaceID, existing); err != nil {
			return "", false, err
		}
		return existing, true, nil
	}
	token, err = NewGitCredentialExchangeToken()
	if err != nil {
		return "", false, err
	}
	return token, false, nil
}

func readHelperExchangeToken(helperPath string) string {
	if strings.TrimSpace(helperPath) == "" {
		return ""
	}
	f, err := os.OpenFile(helperPath, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return ""
	}
	defer f.Close()
	// Only a helper this agent wrote can carry the workspace's bearer.
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || !ownedByCurrentUser(info) {
		return ""
	}
	content, err := io.ReadAll(io.LimitReader(f, gitCredentialHelperScriptMaxBytes))
	if err != nil {
		return ""
	}
	return ExchangeTokenFromHelperScript(string(content))
}

func gitCredentialExchangeDigestMissing(workspaceID string) bool {
	_, err := os.Lstat(gitCredentialExchangeDigestPath(workspaceID))
	return os.IsNotExist(err)
}

// ownedByCurrentUser reports whether a file belongs to this process's user, so
// a file another local user pre-created at a predictable /tmp path is ignored.
func ownedByCurrentUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Geteuid()
}

func gitCredentialExchangeDigestPath(workspaceID string) string {
	workspaceDigest := sha256.Sum256([]byte(strings.TrimSpace(workspaceID)))
	return "/tmp/git-credential-sam-exchange-" + hex.EncodeToString(workspaceDigest[:])
}

func writeGitCredentialExchangeDigest(workspaceID string, digest []byte) error {
	path := gitCredentialExchangeDigestPath(workspaceID)
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("refusing to replace non-regular git credential exchange path %s", path)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect git credential exchange digest: %w", err)
	}

	tempFile, err := os.CreateTemp("/tmp", "git-credential-sam-exchange-write-*")
	if err != nil {
		return fmt.Errorf("create git credential exchange digest: %w", err)
	}
	tempPath := tempFile.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tempPath)
		}
	}()

	if _, err := tempFile.WriteString(hex.EncodeToString(digest)); err != nil {
		_ = tempFile.Close()
		return fmt.Errorf("write git credential exchange digest: %w", err)
	}
	if err := tempFile.Close(); err != nil {
		return fmt.Errorf("finalize git credential exchange digest: %w", err)
	}
	if err := os.Chmod(tempPath, 0o600); err != nil {
		return fmt.Errorf("restrict git credential exchange digest: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("install git credential exchange digest: %w", err)
	}
	cleanup = false
	return nil
}

func removeGitCredentialExchange(workspaceID string) error {
	if strings.TrimSpace(workspaceID) == "" {
		return nil
	}
	if err := os.Remove(gitCredentialExchangeDigestPath(workspaceID)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove git credential exchange digest: %w", err)
	}
	return nil
}
