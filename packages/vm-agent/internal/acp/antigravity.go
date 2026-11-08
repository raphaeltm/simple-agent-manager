package acp

import (
	_ "embed" // Register go:embed support for the shared installer below.

	acpsdk "github.com/coder/acp-go-sdk"
)

// antigravityVersion pins the agy-acp-server release from the ACP registry
// (agentclientprotocol/registry antigravity-acp/agent.json). The installer
// verifies the archive digest before extraction.
const antigravityVersion = "1.4.5"

//go:embed antigravity_install.sh
var antigravityInstallScript string

// antigravityVersionCheckCommand checks the launcher the installer writes: its
// version marker, then that the release files it launches still exist.
// agy_acp_server.par has no flag that prints its release version.
func antigravityVersionCheckCommand() string {
	return `launcher="$(command -v agy-acp)" && grep -Fqx '# sam-antigravity-version=` + antigravityVersion +
		`' "$launcher" && "$launcher" --sam-check-install`
}

// antigravityAuthMethodID selects Gemini API key auth. Antigravity refuses
// session/new until a method is chosen, and reads the key from GEMINI_API_KEY.
const antigravityAuthMethodID = "gemini-api-key"

// acpAuthMethodID names the ACP auth method SAM must select after initialize,
// or "" when the agent authenticates from its environment alone.
func acpAuthMethodID(agentType string) string {
	if agentType == "google-antigravity" {
		return antigravityAuthMethodID
	}
	return ""
}

// acpSessionMeta returns the _meta sent with session/new and session/load.
func acpSessionMeta(agentType string) map[string]any {
	if agentType == "google-antigravity" {
		// 1.4.2 through 1.4.5 write skills/system/run-workflow/SKILL.md into
		// the session cwd (the user's repository) unless run_workflow is off.
		return map[string]any{
			"antigravity": map[string]any{"disabledTools": []string{"run_workflow"}},
		}
	}
	return harnessLifecycleSessionMeta(agentType)
}

// antigravitySessionModes maps SAM permission modes to the session modes
// agy-acp-server 1.4.5 advertises (default, auto_edit, yolo). It has no plan
// mode; its default mode asks before acting, the closest safe equivalent.
// Every mode is sent explicitly, including default and an unset mode: a loaded
// session may otherwise keep a more permissive mode from an earlier run.
var antigravitySessionModes = map[string]string{
	"":                  "default",
	"default":           "default",
	"plan":              "default",
	"acceptEdits":       "auto_edit",
	"bypassPermissions": "yolo",
}

// acpSessionModeID translates a SAM permission mode to the agent's mode id.
// ok is false when no SetSessionMode request should be sent.
func acpSessionModeID(agentType, permissionMode string) (modeID string, ok bool) {
	if agentType == "google-antigravity" {
		modeID, ok = antigravitySessionModes[permissionMode]
		return modeID, ok
	}
	if permissionMode == "" || permissionMode == "default" {
		return "", false
	}
	return permissionMode, true
}

// acpClientFsCapabilities returns the file-system methods SAM serves to the agent.
func acpClientFsCapabilities(agentType string) acpsdk.FileSystemCapabilities {
	if agentType == "google-antigravity" {
		// Advertising client writes makes Antigravity replace its diff edits
		// with whole-file client_edit_file calls. It runs inside the workspace
		// and reads and writes files natively.
		return acpsdk.FileSystemCapabilities{}
	}
	return acpsdk.FileSystemCapabilities{ReadTextFile: true, WriteTextFile: true}
}

// authMethodID reads the id of whichever AuthMethod variant the agent sent.
func authMethodID(method acpsdk.AuthMethod) string {
	switch {
	case method.Agent != nil:
		return method.Agent.Id
	case method.EnvVar != nil:
		return method.EnvVar.Id
	case method.Terminal != nil:
		return method.Terminal.Id
	}
	return ""
}
