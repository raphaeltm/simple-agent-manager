package server

const openCodeGeneratedDependencies = ".config/opencode/node_modules"

// OpenCode v2 retains XDG_DATA_HOME/opencode (default ~/.local/share/opencode)
// for its SQLite database and sidecars; the generic snapshot roots capture these.
// Keep excluding v1's generated dependencies when restoring older snapshots.
// OpenCode's generated dependency tree is restored from its package metadata;
// retaining its .bin symlinks would incorrectly degrade an otherwise complete
// session snapshot. Package initialization finishes before the server can begin
// capturing snapshots, so the shared HOME exclusion registry is immutable in use.
func init() {
	homeExcludePrefixes = append(homeExcludePrefixes, openCodeGeneratedDependencies)
}
