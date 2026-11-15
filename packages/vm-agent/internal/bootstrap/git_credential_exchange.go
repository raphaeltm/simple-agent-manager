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

	f, err := os.Open(gitCredentialExchangeDigestPath(workspaceID))
	if err != nil {
		return false
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
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
