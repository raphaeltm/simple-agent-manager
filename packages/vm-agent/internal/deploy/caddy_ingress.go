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

// ServesHostname reports whether this environment's active Caddy snippet (the routes the last
// apply or route update gave Caddy) has a site for host. It reads the file each time, so it
// agrees with Caddy across agent restarts and is false once teardown removes the snippet.
func (e *Engine) ServesHostname(host string) (bool, error) {
	content, err := os.ReadFile(e.activeSnippetPath())
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read active Caddy snippet: %w", err)
	}
	host = strings.ToLower(host)
	for _, served := range SnippetHostnames(string(content)) {
		if served == host {
			return true, nil
		}
	}
	return false, nil
}
