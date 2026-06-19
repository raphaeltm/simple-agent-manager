package publish

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/cache"
)

// HostDocker drives the host docker daemon via the docker CLI. It is the
// production Docker implementation the orchestrator uses to re-tag and re-push
// the captured built images. The same daemon ran `docker compose publish`, so
// the built images are already present content-addressed by digest.
type HostDocker struct{}

// NewHostDocker returns a Docker backed by the host docker CLI.
func NewHostDocker() *HostDocker { return &HostDocker{} }

// Login authenticates the host daemon to the registry. It reuses
// cache.DockerLogin, which feeds the password via stdin and redacts it on error.
func (d *HostDocker) Login(ctx context.Context, registry, username, password string) error {
	return cache.DockerLogin(ctx, registry, username, password)
}

// Tag re-tags a source image (already in the daemon) under a new reference.
func (d *HostDocker) Tag(ctx context.Context, source, target string) error {
	cmd := exec.CommandContext(ctx, "docker", "tag", source, target)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("docker tag %s -> %s: %w: %s", source, target, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// pushDigestRe extracts the content digest docker prints on a successful push,
// e.g. "latest: digest: sha256:abc... size: 1234".
var pushDigestRe = regexp.MustCompile(`digest:\s*(sha256:[0-9a-f]{64})`)

// Push pushes a tagged reference and returns the digest the registry recorded.
// An empty digest is returned (without error) if docker's output did not include
// one; the orchestrator falls back to the captured digest in that case.
func (d *HostDocker) Push(ctx context.Context, ref string) (string, error) {
	start := time.Now()
	cmd := exec.CommandContext(ctx, "docker", "push", ref)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("docker push %s: %w: %s (after %s)", ref, err, strings.TrimSpace(string(out)), time.Since(start).Round(time.Millisecond))
	}
	if m := pushDigestRe.FindStringSubmatch(string(out)); m != nil {
		return m[1], nil
	}
	return "", nil
}
