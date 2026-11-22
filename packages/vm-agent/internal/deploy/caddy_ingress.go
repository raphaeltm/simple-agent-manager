package deploy

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// rootCaddyfileOptions is the node-wide Caddy configuration every root Caddyfile write uses.
func (e *Engine) rootCaddyfileOptions() CaddyfileOptions {
	return CaddyfileOptions{
		ACMEEmail:        e.cfg.ACMEEmail,
		ACMECA:           e.cfg.ACMECA,
		LoopbackHTTPPort: e.cfg.AppIngressLoopbackPort,
	}
}

// activeSnippetPath is this environment's site file under the root Caddyfile's import.
func (e *Engine) activeSnippetPath() string {
	return filepath.Join(filepath.Dir(e.cfg.CaddyfilePath), "sites", SafeEnvironmentFilePart(e.cfg.EnvironmentID)+".caddy")
}

// ActiveSitesServeHostname reports whether any environment's active Caddy snippet (the files the
// root Caddyfile at caddyfilePath imports from sites/) has a site for host. It reads the files each
// time, so it agrees with what Caddy was last given from the moment the agent starts, before any
// engine is rebuilt from the control plane, and is false once teardown removes a snippet.
func ActiveSitesServeHostname(caddyfilePath, host string) (bool, error) {
	paths, err := filepath.Glob(filepath.Join(filepath.Dir(caddyfilePath), "sites", "*.caddy"))
	if err != nil {
		return false, fmt.Errorf("list active Caddy snippets: %w", err)
	}
	host = strings.ToLower(host)
	for _, path := range paths {
		content, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue // removed by a teardown between the listing and the read
		}
		if err != nil {
			return false, fmt.Errorf("read active Caddy snippet: %w", err)
		}
		for _, served := range SnippetHostnames(string(content)) {
			if served == host {
				return true, nil
			}
		}
	}
	return false, nil
}
