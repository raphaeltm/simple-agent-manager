package deploy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const dockerSaveArchiveType = "docker-save"

func (e *Engine) loadImageArtifacts(ctx context.Context, artifacts []ImageArtifact) error {
	if len(artifacts) == 0 {
		return nil
	}
	dir, err := os.MkdirTemp("", "sam-image-artifacts-*")
	if err != nil {
		return fmt.Errorf("create artifact temp dir: %w", err)
	}
	defer os.RemoveAll(dir)

	for _, artifact := range artifacts {
		if err := e.loadImageArtifact(ctx, dir, artifact); err != nil {
			return err
		}
	}
	return nil
}

func (e *Engine) loadImageArtifact(ctx context.Context, dir string, artifact ImageArtifact) error {
	if strings.TrimSpace(artifact.ServiceName) == "" {
		return fmt.Errorf("artifact missing serviceName")
	}
	if artifact.ArchiveType != dockerSaveArchiveType {
		return fmt.Errorf("artifact %s uses unsupported archive type %q", artifact.ServiceName, artifact.ArchiveType)
	}
	if artifact.SizeBytes <= 0 {
		return fmt.Errorf("artifact %s has invalid size %d", artifact.ServiceName, artifact.SizeBytes)
	}
	if strings.TrimSpace(artifact.ArchiveSHA256) == "" {
		return fmt.Errorf("artifact %s missing archiveSha256", artifact.ServiceName)
	}
	if strings.TrimSpace(artifact.DownloadURL) == "" {
		return fmt.Errorf("artifact %s missing downloadUrl", artifact.ServiceName)
	}
	if strings.TrimSpace(artifact.LocalImageRef) == "" {
		return fmt.Errorf("artifact %s missing localImageRef", artifact.ServiceName)
	}
	if strings.TrimSpace(artifact.SourceRef) == "" {
		return fmt.Errorf("artifact %s missing sourceRef", artifact.ServiceName)
	}

	path := filepath.Join(dir, SafeEnvironmentFilePart(artifact.ServiceName)+".tar")
	if err := e.downloadArtifact(ctx, artifact, path); err != nil {
		return err
	}
	if err := e.dockerLoad(ctx, path); err != nil {
		return fmt.Errorf("load artifact %s: %w", artifact.ServiceName, err)
	}
	if err := e.dockerTag(ctx, artifact.SourceRef, artifact.LocalImageRef); err != nil {
		return fmt.Errorf("tag artifact %s image %s -> %s: %w", artifact.ServiceName, artifact.SourceRef, artifact.LocalImageRef, err)
	}
	slog.Info("deploy.artifact: loaded image",
		"service", artifact.ServiceName,
		"sourceRef", artifact.SourceRef,
		"localImageRef", artifact.LocalImageRef,
		"r2Key", artifact.R2Key,
		"sizeBytes", artifact.SizeBytes)
	return nil
}

func (e *Engine) downloadArtifact(ctx context.Context, artifact ImageArtifact, path string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.DownloadURL, nil)
	if err != nil {
		return fmt.Errorf("create artifact download request: %w", err)
	}
	resp, err := e.cfg.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("download artifact %s: %w", artifact.ServiceName, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("download artifact %s returned %d: %s", artifact.ServiceName, resp.StatusCode, string(body))
	}

	file, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create artifact file: %w", err)
	}
	defer file.Close()

	hasher := sha256.New()
	written, err := io.Copy(file, io.TeeReader(io.LimitReader(resp.Body, artifact.SizeBytes+1), hasher))
	if err != nil {
		return fmt.Errorf("write artifact %s: %w", artifact.ServiceName, err)
	}
	if written != artifact.SizeBytes {
		return fmt.Errorf("artifact %s size mismatch: expected %d bytes, got %d", artifact.ServiceName, artifact.SizeBytes, written)
	}
	hash := "sha256:" + hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(hash, artifact.ArchiveSHA256) {
		return fmt.Errorf("artifact %s sha256 mismatch: expected %s, got %s", artifact.ServiceName, artifact.ArchiveSHA256, hash)
	}
	return nil
}

func (e *Engine) dockerLoad(ctx context.Context, archivePath string) error {
	cmd := exec.CommandContext(ctx, e.composeBinary(), "load", "-i", archivePath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker load: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (e *Engine) dockerTag(ctx context.Context, sourceRef, localRef string) error {
	cmd := exec.CommandContext(ctx, e.composeBinary(), "tag", sourceRef, localRef)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker tag: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
