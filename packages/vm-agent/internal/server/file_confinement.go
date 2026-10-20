package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
)

// Working-tree confinement for the file and git endpoints (idea 01M59MYE4GY91BWTE8TZF1ZB5D).
//
// A teammate a chat is shared with reads the workspace through the control plane, which asks
// for ?confine=workdir. Every path is then relative to the repository working tree, every
// symlink in it is resolved inside the workspace, and the real path must stay inside the
// working tree and outside its .git directory. The response carries pathConfinementHeader;
// the control plane returns nothing to a teammate without it, so an agent that predates this
// code fails closed. The owner's requests carry no confine parameter and are unchanged.
const (
	pathConfinementParam   = "confine"
	pathConfinementWorkDir = "workdir"
	pathConfinementHeader  = "X-SAM-Path-Confinement"
)

// errPathOutsideWorkTree marks a path that is not available under confinement: outside the
// working tree, inside .git, or unresolvable. It answers as not found.
var errPathOutsideWorkTree = errors.New("path is outside the repository working tree")

// requestedConfinement reports whether the request asks for working-tree confinement and, if
// so, marks the response as enforcing it. An unknown value is refused rather than ignored.
func requestedConfinement(w http.ResponseWriter, r *http.Request) (bool, error) {
	switch r.URL.Query().Get(pathConfinementParam) {
	case "":
		return false, nil
	case pathConfinementWorkDir:
		w.Header().Set(pathConfinementHeader, pathConfinementWorkDir)
		return true, nil
	default:
		return false, fmt.Errorf("unsupported %s value", pathConfinementParam)
	}
}

// sanitizeConfinedPath accepts only a relative path: no absolute or home-relative path, no
// traversal, no line breaks (resolution output is read line by line). The result starts with
// "./" so no command reads it as an option.
func sanitizeConfinedPath(path string) (string, error) {
	if err := sanitizeFilePath(path); err != nil {
		return "", err
	}
	if strings.HasPrefix(path, "/") || strings.HasPrefix(path, "~") {
		return "", errPathOutsideWorkTree
	}
	if strings.ContainsAny(path, "\r\n") {
		return "", fmt.Errorf("file path contains a line break")
	}
	cleaned := filepath.Clean(path)
	if cleaned == "." {
		return ".", nil
	}
	return "./" + cleaned, nil
}

// confinedGitPath is the path git commands receive under confinement: relative and cleaned,
// so git reads it from the working tree root.
func confinedGitPath(path string) (string, error) {
	confined, err := sanitizeConfinedPath(path)
	if err != nil {
		return "", err
	}
	return strings.TrimPrefix(confined, "./"), nil
}

// resolveConfinedPath resolves every symlink in path, inside the workspace and as its user,
// and returns the real path when it is the working tree or inside it. The caller reads the
// returned path, not the requested one.
func (s *Server) resolveConfinedPath(ctx context.Context, containerID, user, workDir, path string) (string, error) {
	confined, err := sanitizeConfinedPath(path)
	if err != nil {
		return "", err
	}
	// One exec resolves both, as the workspace sees them: "." is the working tree itself.
	out, _, err := s.execInContainer(ctx, containerID, user, workDir, "realpath", ".", confined)
	if err != nil {
		// A missing component, or no realpath in the image: nothing can be read either way.
		return "", fmt.Errorf("%w: resolve path: %v", errPathOutsideWorkTree, err)
	}
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 2 {
		// A resolved path containing a line break could forge the second line.
		return "", errPathOutsideWorkTree
	}
	return confineResolvedPath(lines[0], lines[1])
}

// confineResolvedPath checks a resolved target against the resolved working tree.
func confineResolvedPath(root, target string) (string, error) {
	if !filepath.IsAbs(root) || !filepath.IsAbs(target) {
		return "", fmt.Errorf("%w: unexpected resolution output", errPathOutsideWorkTree)
	}
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	// A working tree at the filesystem root would confine nothing.
	if root == string(filepath.Separator) {
		return "", errPathOutsideWorkTree
	}
	inside := target == root || strings.HasPrefix(target, root+string(filepath.Separator))
	gitDir := filepath.Join(root, ".git")
	inGitDir := target == gitDir || strings.HasPrefix(target, gitDir+string(filepath.Separator))
	if !inside || inGitDir {
		return "", errPathOutsideWorkTree
	}
	return target, nil
}

// writeConfinementError answers a refused confined path. A malformed path is a bad request;
// anything else reads as not found, so a teammate learns nothing about what exists beyond the
// working tree.
func writeConfinementError(w http.ResponseWriter, err error) {
	if errors.Is(err, errPathOutsideWorkTree) {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}
	writeError(w, http.StatusBadRequest, err.Error())
}
