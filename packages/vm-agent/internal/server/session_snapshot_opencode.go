package server

const openCodeGeneratedDependencies = ".config/opencode/node_modules"

// OpenCode's generated dependency tree is restored from its package metadata;
// retaining its .bin symlinks would incorrectly degrade an otherwise complete
// session snapshot. Package initialization finishes before the server can begin
// capturing snapshots, so the shared HOME exclusion registry is immutable in use.
func init() {
	homeExcludePrefixes = append(homeExcludePrefixes, openCodeGeneratedDependencies)
}
