package provision

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/workspace/vm-agent/internal/oci"
)

// hostCABundlePath is where the receiver's self-signed CA is installed so the
// host docker daemon (and any host-side TLS client) trusts the loopback
// registry. update-ca-certificates picks up *.crt files in this directory.
const hostCABundlePath = "/usr/local/share/ca-certificates/sam-registry-local.crt"

// registryHostsAlias is the loopback alias the registry cert is issued for. The
// host daemon resolves this to 127.0.0.1 to reach the receiver.
const registryHostsAlias = "sam-registry.local"

// installOCIRegistryTrust makes the host docker daemon trust the loopback OCI
// receiver so it can push the re-tagged built images over TLS. It is idempotent
// and safe to run regardless of whether the receiver has already generated its
// cert (oci.EnsureCert is itself idempotent).
//
// Steps:
//  1. Ensure the SAN cert/key pair exists (no-op if the receiver made it first).
//  2. Drop the cert into docker's per-registry cert dir so `docker push` to the
//     publish host validates the TLS chain.
//  3. Install the cert into the host CA store so other host-side clients trust it.
//  4. Add the loopback hosts entry so the publish host resolves to 127.0.0.1.
func installOCIRegistryTrust(certPath, keyPath, publishHost string) error {
	if certPath == "" || keyPath == "" || publishHost == "" {
		return fmt.Errorf("oci-trust: certPath, keyPath, and publishHost required")
	}

	if err := oci.EnsureCert(certPath, keyPath); err != nil {
		return fmt.Errorf("oci-trust: ensure cert: %w", err)
	}

	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return fmt.Errorf("oci-trust: read cert: %w", err)
	}

	// docker reads /etc/docker/certs.d/<host:port>/ca.crt at push time, so the
	// directory name must match the registry reference exactly (including port).
	dockerCertDir := filepath.Join("/etc/docker/certs.d", publishHost)
	if err := os.MkdirAll(dockerCertDir, 0o755); err != nil {
		return fmt.Errorf("oci-trust: mkdir docker certs.d: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dockerCertDir, "ca.crt"), certPEM, 0o644); err != nil {
		return fmt.Errorf("oci-trust: write docker ca.crt: %w", err)
	}

	if err := installHostCA(certPEM); err != nil {
		return fmt.Errorf("oci-trust: install host CA: %w", err)
	}

	if err := ensureHostsEntry(registryHostsAlias); err != nil {
		return fmt.Errorf("oci-trust: hosts entry: %w", err)
	}

	return nil
}

// installHostCA writes the cert to the host CA store and refreshes the bundle.
// update-ca-certificates is idempotent; rewriting the same cert is a no-op.
func installHostCA(certPEM []byte) error {
	if err := os.WriteFile(hostCABundlePath, certPEM, 0o644); err != nil {
		return err
	}
	cmd := exec.Command("update-ca-certificates")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// ensureHostsEntry appends "127.0.0.1 <alias>" to /etc/hosts if not present.
func ensureHostsEntry(alias string) error {
	const hostsPath = "/etc/hosts"
	data, err := os.ReadFile(hostsPath)
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		for _, field := range strings.Fields(line) {
			if field == alias {
				return nil // already mapped
			}
		}
	}
	f, err := os.OpenFile(hostsPath, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = fmt.Fprintf(f, "127.0.0.1 %s\n", alias)
	return err
}
