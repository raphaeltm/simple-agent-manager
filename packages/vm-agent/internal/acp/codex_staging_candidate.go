package acp

import (
	"context"
	"fmt"
)

// An explicit verification profile supplies this through the Cloudflare-authorized
// per-session runtime-assets path. It is never read from the VM-agent host env.
const codexC2CandidateEnv = "SAM_CODEX_C2_CANDIDATE"
const codexC2ReleaseRoot = "/opt/sam-codex-c2"
const codexC2ReleaseIdentity = "sam-codex-acp-2.1.1-sam-c2.2+cli-0.160.0-sam-c2.2-codemode2"

// The catalog is outside the candidate and its digest is compiled into the
// VM agent, so a rewritten release-owned manifest cannot authorize a
// modified executable. A failed check never invokes npm or the stock adapter.
const codexC2CandidateCheck = `set -eu; root=/opt/sam-codex-c2; id=sam-codex-acp-2.1.1-sam-c2.2+cli-0.160.0-sam-c2.2-codemode2; release="$root/releases/$id"; catalog="$root/catalog/$id.sha256"; [ "$(uname -m)" = x86_64 ] && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] && [ "$(readlink -f "$root/current")" = "$release" ] && [ ! -L "$release" ] && [ ! -L "$catalog" ] && [ "$(sha256sum "$catalog" | cut -d ' ' -f 1)" = 02c1b8818f856effeb90a076ace5ab70a9e25b81dadcbf78be000f53113c3b1e ] && [ -x "$release/bin/codex" ] && [ -x "$release/bin/codex-acp" ] && [ -x "$release/payload/codex" ] && [ -x "$release/payload/codex-code-mode-host" ] && [ -z "$(find "$release" -type l -print -quit)" ] && [ "$(cd "$release" && find . -type f -printf '%P\n' | sort)" = "$(printf '%s\n' bin/codex bin/codex-acp payload/SHA256SUMS payload/SOURCE-PROVENANCE payload/adapter.js payload/codex payload/codex-code-mode-host | sort)" ] && (cd "$release" && sha256sum --check --status "$catalog") && [ "$("$root/current/bin/codex" --version)" = 'codex-cli 0.160.0-sam-c2.2' ] && [ "$("$root/current/bin/codex-acp" --version)" = '@agentclientprotocol/codex-acp 2.1.1-sam-c2.2' ]`

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

func selectCodexC2Candidate(info agentCommandInfo, agentType, selector string) (agentCommandInfo, error) {
	if agentType != "openai-codex" {
		return info, nil
	}
	switch selector {
	case "":
		return info, nil
	case "1":
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
// selection. Later capability updates cannot silently replace that executable.
// Explicit profile markers remain independently checked on every restart.
func (h *SessionHost) selectSessionCodexRuntime(agentType, explicit string) (string, error) {
	if agentType != "openai-codex" {
		return "", nil
	}
	if explicit != "" && explicit != "1" {
		return "", fmt.Errorf("invalid %s selector", codexC2CandidateEnv)
	}
	config := h.acpInteractionConfigSnapshot()
	h.codexC2SelectionMu.Lock()
	defer h.codexC2SelectionMu.Unlock()
	if h.codexC2SelectionLatched {
		if explicit != h.codexC2Selector {
			return "", fmt.Errorf("Codex session candidate selector changed during restart or startup")
		}
		return h.codexC2EffectiveSelector, nil
	}
	effective := explicit
	if effective == "" && config.Enabled && (config.FormsEnabled || config.URLsEnabled) {
		if err := config.validate(); err != nil {
			return "", fmt.Errorf("invalid Codex interaction runtime configuration: %w", err)
		}
		effective = "1"
	}
	h.codexC2Selector = explicit
	h.codexC2EffectiveSelector = effective
	h.codexC2SelectionLatched = true
	return effective, nil
}
