package acp

import _ "embed" // Register go:embed support for the shared installer below.

// opencodeVersion is SAM's build of OpenCode v2.2.5 with the ACP `_session/steering`
// patch (scripts/opencode/), published as the `opencode-v<version>` GitHub release.
const opencodeVersion = "2.2.5-sam-s1"

// opencodeDisableAutoupdateEnvName turns off OpenCode's self-updater for SAM sessions.
const opencodeDisableAutoupdateEnvName = "OPENCODE_DISABLE_AUTOUPDATE"

// Shared with the Instant image through Makefile prepare-container. Release
// digests are checked before extraction; no remote install script is executed.
//
//go:embed opencode_install.sh
var opencodeInstallScript string
