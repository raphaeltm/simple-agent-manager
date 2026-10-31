package acp

import _ "embed" // Register go:embed support for the shared installer below.

const opencodeVersion = "2.2.5"

// Shared with the Instant image through Makefile prepare-container. Release
// digests are checked before extraction; no remote install script is executed.
//
//go:embed opencode_install.sh
var opencodeInstallScript string
