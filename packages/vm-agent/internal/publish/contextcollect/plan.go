package contextcollect

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/compose-spec/compose-go/v2/cli"
	"github.com/compose-spec/compose-go/v2/loader"
	"github.com/moby/patternmatcher"
	"github.com/moby/patternmatcher/ignorefile"
	"os"
	"path/filepath"
	"strings"
)

type buildContext struct {
	path     string
	matchers []*patternmatcher.PatternMatcher
}
type collectionPlan struct {
	root          string
	contexts      []buildContext
	forced, empty map[string]bool
	sensitive     []os.FileInfo
}

func makePlan(ctx context.Context, opts Options) (*collectionPlan, error) {
	p := &collectionPlan{root: opts.Root, forced: map[string]bool{}, empty: map[string]bool{}}
	env := make([]string, 0, len(opts.BuildEnv)+len(opts.SecretKeys))
	for k, v := range opts.BuildEnv {
		env = append(env, k+"="+v)
	}
	for _, k := range opts.SecretKeys {
		env = append(env, k+"="+SecretPlaceholder)
	}
	temp, err := os.MkdirTemp("", "sam-context-config-graph-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(temp)
	envMap := map[string]string{}
	for k, v := range opts.BuildEnv {
		envMap[k] = v
	}
	for _, k := range opts.SecretKeys {
		envMap[k] = SecretPlaceholder
	}
	graph := &localLoader{p: p, max: opts.MaxBytes, temp: temp, env: envMap, staged: map[string]string{}, originals: map[string]string{}, visiting: map[string]bool{}}
	options, err := cli.NewProjectOptions(nil, cli.WithWorkingDirectory(opts.Root), cli.WithEnv(env), cli.WithConfigFileEnv, cli.WithDefaultConfigPath, cli.WithoutEnvironmentResolution, cli.WithoutLabelsResolution, cli.WithProfiles([]string{"*"}), cli.WithResourceLoader(graph), cli.WithLoadOptions(func(o *loader.Options) { o.SkipResolveEnvironment = true }))
	if err != nil {
		return nil, err
	}
	for _, path := range options.ConfigPaths {
		if err := p.force(path, opts.MaxBytes); err != nil {
			return nil, err
		}
	}
	project, err := options.LoadProject(ctx)
	if err != nil {
		return nil, fmt.Errorf("load Compose build context: %w", err)
	}
	for _, path := range project.ComposeFiles {
		if original, ok := graph.originals[path]; ok {
			path = original
		}
		if err := p.force(path, opts.MaxBytes); err != nil {
			return nil, err
		}
	}
	// Host env and dotenv are never loaded. Build interpolation uses only the
	// server's non-secret config and the node executor's secret placeholders.
	if err := p.markEmpty(filepath.Join(opts.Root, ".env")); err != nil {
		return nil, err
	}
	for _, service := range project.AllServices() {
		for _, file := range service.EnvFiles {
			path := file.Path
			if !filepath.IsAbs(path) {
				path = filepath.Join(project.WorkingDir, path)
			}
			if err := validatePath(opts.Root, path); err != nil {
				return nil, err
			}
			if err := p.markEmpty(path); err != nil {
				return nil, err
			}
		}
		if service.Build == nil {
			continue
		}
		b := service.Build
		encoded, err := json.Marshal(b)
		if err != nil {
			return nil, err
		}
		if strings.Contains(string(encoded), SecretPlaceholder) || strings.Contains(service.Image, SecretPlaceholder) {
			return nil, fmt.Errorf("service %s uses a runtime secret in build/image fields; use non-secret build config", service.Name)
		}
		if err := p.addContext(b.Context, b.Dockerfile, opts.MaxBytes); err != nil {
			return nil, fmt.Errorf("service %s: %w", service.Name, err)
		}
		for name, path := range b.AdditionalContexts {
			if err := p.addContext(path, "", opts.MaxBytes); err != nil {
				return nil, fmt.Errorf("service %s additional_context %s: %w", service.Name, name, err)
			}
		}
	}
	for _, s := range project.Secrets {
		if s.File != "" {
			if err := validatePath(opts.Root, s.File); err != nil {
				return nil, err
			}
			if err := p.markEmpty(s.File); err != nil {
				return nil, err
			}
		}
	}
	for _, s := range project.Configs {
		if s.File != "" {
			if err := validatePath(opts.Root, s.File); err != nil {
				return nil, err
			}
			if err := p.markEmpty(s.File); err != nil {
				return nil, err
			}
		}
	}
	return p, nil
}
func (p *collectionPlan) force(path string, max int64) error {
	if !filepath.IsAbs(path) {
		path = filepath.Join(p.root, path)
	}
	if err := validatePath(p.root, path); err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("Compose input %s must be a regular file", path)
	}
	if info.Size() > max {
		return fmt.Errorf("Compose input %s exceeds maximum %d bytes", path, max)
	}
	p.forced[path] = true
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	p.forced[canonical] = true
	for parent := filepath.Dir(path); within(p.root, parent) && parent != p.root; parent = filepath.Dir(parent) {
		if info, err := os.Lstat(parent); err == nil && info.Mode()&os.ModeSymlink != 0 {
			p.forced[parent] = true
		}
	}
	return nil
}
func (p *collectionPlan) addContext(path, dockerfile string, max int64) error {
	if path == "" {
		path = p.root
	}
	if remoteContext(path) {
		return fmt.Errorf("non-local context %q is unsupported; use a local directory", path)
	}
	if !filepath.IsAbs(path) {
		if strings.Contains(path, ":") {
			return fmt.Errorf("non-local context %q is unsupported; use a local directory", path)
		}
		path = filepath.Join(p.root, path)
	}
	if err := validatePath(p.root, path); err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("build context %s: %w", path, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("build context %s must be a local directory", path)
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	if canonical != path {
		p.forced[path] = true
		for parent := filepath.Dir(path); within(p.root, parent) && parent != p.root; parent = filepath.Dir(parent) {
			if info, err := os.Lstat(parent); err == nil && info.Mode()&os.ModeSymlink != 0 {
				p.forced[parent] = true
			}
		}
	}
	c := buildContext{path: canonical}
	// Named additional contexts are passed through conservatively: BuildKit's
	// named-context filtering differs across frontends, so never drop their files.
	ignores := []string{}
	if dockerfile != "" {
		ignores = append(ignores, filepath.Join(path, ".dockerignore"))
	}
	if dockerfile != "" {
		if !filepath.IsAbs(dockerfile) {
			dockerfile = filepath.Join(path, dockerfile)
		}
		if err := p.force(dockerfile, max); err != nil {
			return err
		}
		ignores = append(ignores, dockerfile+".dockerignore")
	}
	for _, ignore := range ignores {
		if _, err := os.Lstat(ignore); os.IsNotExist(err) {
			continue
		}
		if err := p.force(ignore, max); err != nil {
			return err
		}
		file, err := os.Open(ignore)
		if err != nil {
			return err
		}
		patterns, err := ignorefile.ReadAll(file)
		file.Close()
		if err != nil {
			return err
		}
		matcher, err := patternmatcher.New(patterns)
		if err != nil {
			return err
		}
		c.matchers = append(c.matchers, matcher)
	}
	p.contexts = append(p.contexts, c)
	return nil
}
func (p *collectionPlan) includes(path string) (bool, error) {
	if p.forced[path] || p.empty[path] {
		return true, nil
	}
	for _, c := range p.contexts {
		if !within(c.path, path) {
			continue
		}
		rel, _ := filepath.Rel(c.path, path)
		if len(c.matchers) == 0 {
			return true, nil
		}
		for _, m := range c.matchers {
			ignored, err := m.MatchesOrParentMatches(rel)
			if err != nil {
				return false, err
			}
			if !ignored {
				return true, nil
			}
		}
	}
	return false, nil
}
func (p *collectionPlan) descends(path string) bool {
	for _, c := range p.contexts {
		if within(path, c.path) || within(c.path, path) {
			return true
		}
	}
	for f := range p.forced {
		if within(path, f) {
			return true
		}
	}
	for f := range p.empty {
		if within(path, f) {
			return true
		}
	}
	return false
}

func (p *collectionPlan) markEmpty(path string) error {
	if err := validatePath(p.root, path); err != nil {
		return err
	}
	p.empty[path] = true
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("runtime env/secret file %s must be a regular file", path)
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	p.empty[canonical] = true
	p.sensitive = append(p.sensitive, info)
	return nil
}
func (p *collectionPlan) isSensitive(path string, info os.FileInfo) bool {
	if p.empty[path] {
		return true
	}
	for _, secret := range p.sensitive {
		if os.SameFile(secret, info) {
			return true
		}
	}
	return false
}
