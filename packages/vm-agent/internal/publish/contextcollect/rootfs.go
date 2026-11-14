package contextcollect

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"github.com/compose-spec/compose-go/v2/cli"
)

// Absolute paths are labels for Compose's path resolver, never host IO paths.
func (p *collectionPlan) relative(path string) (string, error) {
	if !filepath.IsAbs(path) {
		path = filepath.Join(p.root, path)
	}
	if !within(p.root, path) {
		return "", fmt.Errorf("path %s escapes working directory", path)
	}
	return filepath.Rel(p.root, path)
}
func (p *collectionPlan) stat(path string) (os.FileInfo, error) {
	rel, err := p.relative(path)
	if err != nil {
		return nil, err
	}
	return p.source.Stat(rel)
}
func (p *collectionPlan) lstat(path string) (os.FileInfo, error) {
	rel, err := p.relative(path)
	if err != nil {
		return nil, err
	}
	return p.source.Lstat(rel)
}
func (p *collectionPlan) open(path string) (*os.File, error) {
	rel, err := p.relative(path)
	if err != nil {
		return nil, err
	}
	file, err := p.source.OpenFile(rel, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, fmt.Errorf("input %s must remain a regular file while collecting", rel)
	}
	return file, nil
}

// Nonblocking opens make a directory-to-FIFO swap fail rather than strand a
// collection past its deadline. Every open remains relative to the capability.
type rootWalkFS struct{ root *os.Root }

func (s rootWalkFS) Open(name string) (fs.File, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrInvalid}
	}
	return s.root.OpenFile(filepath.FromSlash(name), os.O_RDONLY|syscall.O_NONBLOCK, 0)
}
func (p *collectionPlan) validatePath(path string) error {
	_, err := p.resolvePath(path)
	return err
}

// Match compose-go's filename/override precedence without its plain host Stat
// calls or parent-directory search outside the chosen source capability.
func (p *collectionPlan) discover(options *cli.ProjectOptions) error {
	if len(options.ConfigPaths) != 0 {
		return nil
	}
	for _, names := range [][]string{cli.DefaultFileNames, cli.DefaultOverrideFileNames} {
		found := false
		for _, name := range names {
			info, err := p.source.Stat(name)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return fmt.Errorf("read Compose discovery input %s: %w", name, err)
			}
			if !info.Mode().IsRegular() {
				continue
			}
			options.ConfigPaths = append(options.ConfigPaths, filepath.Join(p.root, name))
			found = true
			break
		}
		if !found && len(options.ConfigPaths) == 0 {
			return fmt.Errorf("no Compose file in workingDir; select the directory containing your Compose project")
		}
	}
	return nil
}
