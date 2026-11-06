package acp

import (
	"context"
	"fmt"
)

// Every Codex session runs SAM's reviewed C2 runtime: it is the only Codex
// adapter that can steer (`promptRequired`, see session_host_steering.go). An
// agent profile may opt out with SAM_CODEX_C2_CANDIDATE=0 to run the stock npm
// pin instead, for a devcontainer C2 cannot run in (arm64, Node older than 22);
// that session cannot steer. The marker arrives through the Cloudflare-authorized
// per-session runtime-assets path and is never read from the VM-agent host env.
const codexC2CandidateEnv = "SAM_CODEX_C2_CANDIDATE"

const (
	codexRuntimeC2    = "1"
	codexRuntimeStock = "0"
)
const codexC2ReleaseRoot = "/opt/sam-codex-c2"
const codexC2ReleaseIdentity = "sam-codex-acp-2.1.1-sam-c2.3+cli-0.160.0-sam-c2.2-codemode2"

// The catalog is outside the candidate and its digest is compiled into the
// VM agent, so a rewritten release-owned manifest cannot authorize a
// modified executable. A failed check never invokes npm or the stock adapter.
const codexC2CandidateCheck = `set -eu; root=/opt/sam-codex-c2; id=sam-codex-acp-2.1.1-sam-c2.3+cli-0.160.0-sam-c2.2-codemode2; release="$root/releases/$id"; catalog="$root/catalog/$id.sha256"; [ "$(uname -m)" = x86_64 ] && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] && [ "$(readlink -f "$root/current")" = "$release" ] && [ ! -L "$release" ] && [ ! -L "$catalog" ] && [ "$(sha256sum "$catalog" | cut -d ' ' -f 1)" = 8ad7f5887ea09d76152ee9889b0055ee230b18af30eb070695b7279c550c5d58 ] && [ -x "$release/bin/codex" ] && [ -x "$release/bin/codex-acp" ] && [ -x "$release/payload/codex" ] && [ -x "$release/payload/codex-code-mode-host" ] && [ -z "$(find "$release" -type l -print -quit)" ] && [ "$(cd "$release" && find . -type f -printf '%P\n' | sort)" = "$(printf '%s\n' bin/codex bin/codex-acp payload/SHA256SUMS payload/SOURCE-PROVENANCE payload/adapter.js payload/codex payload/codex-code-mode-host | sort)" ] && (cd "$release" && sha256sum --check --status "$catalog") && [ "$("$root/current/bin/codex" --version)" = 'codex-cli 0.160.0-sam-c2.2' ] && [ "$("$root/current/bin/codex-acp" --version)" = '@agentclientprotocol/codex-acp 2.1.1-sam-c2.3' ]`

func (h *SessionHost) resolveCodexC2Selector(ctx context.Context, agentType string) (string, error) {
	if agentType != "openai-codex" || h.config.RuntimeAssetsProvider == nil {
		return "", nil
	}
	assets, err := h.config.RuntimeAssetsProvider(ctx)
	if err != nil {
		return "", fmt.Errorf("fetch Codex session runtime assets: %w", err)
	}
	selector := ""
	seen := false
	for _, item := range assets.EnvVars {
		if item.Key == codexC2CandidateEnv {
			if seen {
				return "", fmt.Errorf("duplicate %s selector in session runtime assets", codexC2CandidateEnv)
			}
			if item.Value == "" {
				return "", fmt.Errorf("empty %s selector in session runtime assets", codexC2CandidateEnv)
			}
			seen = true
			selector = item.Value
		}
	}
	return selector, nil
}

// codexRuntimeUnavailable names the opt-out, because C2 is the default and a
// devcontainer it cannot run in would otherwise leave Codex unusable.
func codexRuntimeUnavailable(err error) error {
	return fmt.Errorf("SAM Codex runtime unavailable (it needs an x86_64 container with Node 22 or newer; set %s=0 on the agent profile to run the stock adapter, which cannot steer): %w", codexC2CandidateEnv, err)
}

func selectCodexC2Candidate(info agentCommandInfo, agentType, selector string) (agentCommandInfo, error) {
	if agentType != "openai-codex" {
		return info, nil
	}
	switch selector {
	case codexRuntimeStock:
		return info, nil
	case codexRuntimeC2:
		info.command = codexC2ReleaseRoot + "/current/bin/codex-acp"
		info.installCmd = ""
		info.isNpmBased = false
		info.validationCmd = codexC2CandidateCheck
		info.verifyOnly = true
		return info, nil
	default:
		return info, fmt.Errorf("invalid %s selector", codexC2CandidateEnv)
	}
}

// selectSessionCodexRuntime binds an executable to the host at its first Codex
// selection: C2 unless the profile opts out. The choice does not depend on the
// session's task mode or interaction flags, so every Codex session can steer.
// Profile markers remain independently checked on every restart, and a changed
// marker never silently swaps the executable of a running host.
func (h *SessionHost) selectSessionCodexRuntime(agentType, explicit string) (string, error) {
	if agentType != "openai-codex" {
		return "", nil
	}
	if explicit != "" && explicit != codexRuntimeC2 && explicit != codexRuntimeStock {
		return "", fmt.Errorf("invalid %s selector", codexC2CandidateEnv)
	}
	h.codexC2SelectionMu.Lock()
	defer h.codexC2SelectionMu.Unlock()
	if h.codexC2SelectionLatched {
		if explicit != h.codexC2Selector {
			return "", fmt.Errorf("Codex session candidate selector changed during restart or startup")
		}
		return h.codexC2EffectiveSelector, nil
	}
	effective := explicit
	if effective == "" {
		effective = codexRuntimeC2
	}
	h.codexC2Selector = explicit
	h.codexC2EffectiveSelector = effective
	h.codexC2SelectionLatched = true
	return effective, nil
}
