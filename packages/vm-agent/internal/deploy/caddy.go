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

// loopbackSitePrefix marks a plain-HTTP site in a tunnel-ingress snippet.
const loopbackSitePrefix = "http://"

// SnippetHostnames lists the site hostnames of a snippet GenerateCaddySnippet produced, in
// either mode, lowercased. Lines that are not a site address are ignored.
func SnippetHostnames(snippet string) []string {
	var hosts []string
	for _, line := range strings.Split(snippet, "\n") {
		if !strings.HasSuffix(line, " {") || strings.HasPrefix(line, "\t") {
			continue
		}
		host := strings.TrimPrefix(strings.TrimSuffix(line, " {"), loopbackSitePrefix)
		if caddyHostnamePattern.MatchString(host) {
			hosts = append(hosts, strings.ToLower(host))
		}
	}
	return hosts
}

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
	// LoopbackHTTPPort, when positive, is app ingress through the control plane's tunnel (the
	// self-host box): Caddy does no ACME and serves its sites as plain HTTP on this loopback port
	// only. The box terminates TLS and the vm-agent's app-ingress route is the only client. The
	// ACME options are ignored. Zero means public automatic HTTPS (the default).
	LoopbackHTTPPort int
}

func GenerateRootCaddyfile(opts CaddyfileOptions) string {
	var builder strings.Builder
	builder.WriteString("# Managed by SAM deployment agent.\n")
	if global := buildGlobalOptionsBlock(opts); global != "" {
		builder.WriteString(global)
	}
	builder.WriteString("\nimport sites/*\n")
	if opts.LoopbackHTTPPort > 0 {
		// Any host no site claims gets a 404 rather than Caddy's empty 200, so a route that is
		// not (or no longer) loaded is reported as missing through the tunnel, not as an empty app.
		builder.WriteString("\nhttp:// {\n\trespond 404\n}\n")
	}
	return builder.String()
}

// GenerateCaddySnippet renders one site per route. loopbackHTTP renders plain-HTTP sites for
// tunnel app ingress (see CaddyfileOptions.LoopbackHTTPPort); otherwise each site is a bare
// hostname, which Caddy serves with automatic HTTPS.
func GenerateCaddySnippet(routes []RouteTarget, loopbackHTTP bool) (string, error) {
	var builder strings.Builder
	builder.WriteString("# Managed by SAM deployment agent.\n")
	ordered := append([]RouteTarget(nil), routes...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].Hostname < ordered[j].Hostname
	})

	for _, route := range ordered {
		if err := validateRouteTarget(route); err != nil {
			return "", err
		}
		builder.WriteString("\n")
		if loopbackHTTP {
			builder.WriteString(loopbackSitePrefix)
		}
		builder.WriteString(route.Hostname)
		builder.WriteString(" {\n")
		builder.WriteString("\tencode zstd gzip\n")
		builder.WriteString(fmt.Sprintf("\treverse_proxy 127.0.0.1:%d\n", route.HostPort))
		builder.WriteString("}\n")
	}

	return builder.String(), nil
}

func SafeEnvironmentFilePart(environmentID string) string {
	cleaned := strings.ToLower(strings.TrimSpace(environmentID))
	cleaned = regexp.MustCompile(`[^a-z0-9_-]+`).ReplaceAllString(cleaned, "-")
	cleaned = strings.Trim(cleaned, "-_")
	if cleaned == "" {
		return "environment"
	}
	return cleaned
}

// buildGlobalOptionsBlock renders the Caddy global options block for the given
// ACME settings, or the empty string when no options are set (so Caddy defaults
// are used). The email and acme_ca directives only accept whitespace-free tokens,
// which the env-sourced values already are; any internal whitespace is dropped to
// keep the generated config well-formed.
func buildGlobalOptionsBlock(opts CaddyfileOptions) string {
	if opts.LoopbackHTTPPort > 0 {
		// trusted_proxies: the only client of this loopback listener is the vm-agent's app-ingress
		// route, which sets X-Forwarded-Proto https (the box terminated TLS) and extends the box's
		// X-Forwarded-For. Without it Caddy discards both and tells the app the request was plain
		// HTTP from 127.0.0.1, which breaks HTTPS redirects, secure cookies and OAuth callbacks.
		return fmt.Sprintf("{\n\tauto_https off\n\tdefault_bind 127.0.0.1\n\thttp_port %d\n\tservers {\n\t\ttrusted_proxies static 127.0.0.1/32 ::1/128\n\t}\n}\n", opts.LoopbackHTTPPort)
	}
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
