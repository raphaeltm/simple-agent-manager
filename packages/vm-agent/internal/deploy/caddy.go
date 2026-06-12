package deploy

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var caddyHostnamePattern = regexp.MustCompile(`^[A-Za-z0-9.-]+$`)

// CaddyfileOptions carries node-wide ACME/TLS settings emitted in the Caddy
// global options block. All fields are optional; when empty, Caddy's defaults
// apply (auto-HTTPS with the production ACME CA and no contact email).
type CaddyfileOptions struct {
	// ACMEEmail is the contact email registered with the ACME CA. Recommended
	// for production so certificate-expiry and policy notices are deliverable.
	ACMEEmail string
	// ACMECA overrides the ACME directory URL (e.g. the Let's Encrypt staging
	// endpoint) so testing does not consume production issuance rate limits.
	ACMECA string
}

func GenerateCaddyfile(routes []RouteTarget, opts CaddyfileOptions) (string, error) {
	var builder strings.Builder
	builder.WriteString("# Managed by SAM deployment agent.\n")

	if global := buildGlobalOptionsBlock(opts); global != "" {
		builder.WriteString(global)
	}

	ordered := append([]RouteTarget(nil), routes...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].Hostname < ordered[j].Hostname
	})

	for _, route := range ordered {
		if err := validateRouteTarget(route); err != nil {
			return "", err
		}
		builder.WriteString("\n")
		builder.WriteString(route.Hostname)
		builder.WriteString(" {\n")
		builder.WriteString("\tencode zstd gzip\n")
		builder.WriteString(fmt.Sprintf("\treverse_proxy 127.0.0.1:%d\n", route.HostPort))
		builder.WriteString("}\n")
	}

	return builder.String(), nil
}

// buildGlobalOptionsBlock renders the Caddy global options block for the given
// ACME settings, or the empty string when no options are set (so Caddy defaults
// are used). The email and acme_ca directives only accept whitespace-free tokens,
// which the env-sourced values already are; any internal whitespace is dropped to
// keep the generated config well-formed.
func buildGlobalOptionsBlock(opts CaddyfileOptions) string {
	email := strings.Join(strings.Fields(opts.ACMEEmail), "")
	ca := strings.Join(strings.Fields(opts.ACMECA), "")
	if email == "" && ca == "" {
		return ""
	}

	var b strings.Builder
	b.WriteString("{\n")
	if email != "" {
		b.WriteString(fmt.Sprintf("\temail %s\n", email))
	}
	if ca != "" {
		b.WriteString(fmt.Sprintf("\tacme_ca %s\n", ca))
	}
	b.WriteString("}\n")
	return b.String()
}

func validateRouteTarget(route RouteTarget) error {
	if route.Hostname == "" {
		return fmt.Errorf("route hostname is required for service %q", route.Service)
	}
	if !caddyHostnamePattern.MatchString(route.Hostname) || strings.Contains(route.Hostname, "..") {
		return fmt.Errorf("route hostname %q contains invalid Caddy site characters", route.Hostname)
	}
	if route.HostPort <= 0 || route.HostPort > 65535 {
		return fmt.Errorf("route host port %d for %q is outside valid TCP port range", route.HostPort, route.Hostname)
	}
	if route.ContainerPort <= 0 || route.ContainerPort > 65535 {
		return fmt.Errorf("route container port %d for %q is outside valid TCP port range", route.ContainerPort, route.Hostname)
	}
	return nil
}

func writeFileAtomic(path string, content string, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create parent directory: %w", err)
	}

	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("rename temp file: %w", err)
	}
	return nil
}
