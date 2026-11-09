package contextcollect

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/compose-spec/compose-go/v2/template"
	"gopkg.in/yaml.v3"
)

// Compose's include loader reads interpolation env_file even when service env
// resolution is disabled. Stage only the bounded YAML config graph, replacing
// those reads with /dev/null, while keeping original project directories. The
// bundle always contains the original YAML and empty original env-file paths.
type localLoader struct {
	p              *collectionPlan
	max, readBytes int64
	temp           string
	env            map[string]string
	staged         map[string]string
	originals      map[string]string
	visiting       map[string]bool
}

func (l *localLoader) Accept(string) bool { return true }
func (l *localLoader) Dir(path string) string {
	if orig, ok := l.originals[path]; ok {
		return filepath.Dir(orig)
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(l.p.root, path)
	}
	return filepath.Dir(path)
}
func (l *localLoader) Load(ctx context.Context, path string) (string, error) {
	if _, ok := l.originals[path]; ok {
		return path, nil
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(l.p.root, path)
	}
	return l.stage(ctx, path, l.p.root)
}
func (l *localLoader) stage(ctx context.Context, path, base string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	key := path + "\x00" + base
	if l.visiting[key] {
		return "", fmt.Errorf("Compose include/extends cycle at %s", path)
	}
	if copy, ok := l.staged[key]; ok {
		return copy, nil
	}
	if err := l.p.force(path, l.max); err != nil {
		return "", err
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	data, err := io.ReadAll(io.LimitReader(&contextReader{ctx: ctx, r: f}, l.max-l.readBytes+1))
	f.Close()
	if err != nil {
		return "", err
	}
	l.readBytes += int64(len(data))
	if l.readBytes > l.max {
		return "", fmt.Errorf("Compose config graph exceeds maximum %d bytes", l.max)
	}

	l.visiting[key] = true
	defer delete(l.visiting, key)
	var sanitized bytes.Buffer
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	encoder := yaml.NewEncoder(&sanitized)
	for {
		var doc yaml.Node
		if err := decoder.Decode(&doc); err == io.EOF {
			break
		} else if err != nil {
			return "", fmt.Errorf("parse Compose file %s: %w", path, err)
		}
		expanded, err := expandYAML(ctx, &doc, map[*yaml.Node]bool{}, new(int64), l.max)
		if err != nil {
			return "", err
		}
		if len(expanded.Content) > 0 {
			root := expanded.Content[0]
			if inc := mappingValue(root, "include"); inc != nil {
				if err := l.includes(ctx, inc, base); err != nil {
					return "", err
				}
			}
			services := mappingValue(root, "services")
			if services != nil {
				for i := 1; i < len(services.Content); i += 2 {
					ext := mappingValue(services.Content[i], "extends")
					if ext == nil {
						continue
					}
					file := mappingValue(ext, "file")
					if file == nil {
						continue
					}
					original, err := l.path(file.Value, base)
					if err != nil {
						return "", err
					}
					copy, err := l.stage(ctx, original, filepath.Dir(original))
					if err != nil {
						return "", err
					}
					file.Value = copy
				}
			}
		}
		if err := encoder.Encode(expanded); err != nil {
			return "", err
		}
	}
	if err := encoder.Close(); err != nil {
		return "", err
	}
	data = sanitized.Bytes()
	copy, err := os.CreateTemp(l.temp, "compose-*.yaml")
	if err != nil {
		return "", err
	}
	name := copy.Name()
	_, err = copy.Write(data)
	closeErr := copy.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	l.staged[key] = name
	l.originals[name] = path
	return name, nil
}
func (l *localLoader) path(value, base string) (string, error) {
	value, err := template.Substitute(value, func(key string) (string, bool) { v, ok := l.env[key]; return v, ok })
	if err != nil {
		return "", err
	}
	if remoteContext(value) {
		return "", fmt.Errorf("remote Compose reference %q is unsupported; use a local file", value)
	}
	if !filepath.IsAbs(value) {
		value = filepath.Join(base, value)
	}
	if err := validatePath(l.p.root, value); err != nil {
		return "", err
	}
	return value, nil
}
func (l *localLoader) includes(ctx context.Context, inc *yaml.Node, base string) error {
	if inc.Kind != yaml.SequenceNode {
		return fmt.Errorf("Compose include must be a list")
	}
	for i, item := range inc.Content {
		if item.Kind == yaml.ScalarNode {
			item = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: []*yaml.Node{scalar("path"), item}}
			inc.Content[i] = item
		}
		paths := mappingValue(item, "path")
		if paths == nil {
			return fmt.Errorf("Compose include requires path")
		}
		entries := paths.Content
		if paths.Kind == yaml.ScalarNode {
			entries = []*yaml.Node{paths}
		}
		if len(entries) == 0 {
			return fmt.Errorf("Compose include requires a local file")
		}
		originals := make([]string, len(entries))
		for i, entry := range entries {
			p, err := l.path(entry.Value, base)
			if err != nil {
				return err
			}
			originals[i] = p
		}
		projectDir := filepath.Dir(originals[0])
		if dir := mappingValue(item, "project_directory"); dir != nil {
			p, err := l.path(dir.Value, base)
			if err != nil {
				return err
			}
			projectDir = p
		}
		setMapping(item, "project_directory", scalar(projectDir))
		envFiles := mappingValue(item, "env_file")
		if envFiles == nil {
			if err := l.p.markEmpty(filepath.Join(projectDir, ".env")); err != nil {
				return err
			}
		} else {
			files := envFiles.Content
			if envFiles.Kind == yaml.ScalarNode {
				files = []*yaml.Node{envFiles}
			}
			for _, file := range files {
				if file.Value == "/dev/null" {
					continue
				}
				p, err := l.path(file.Value, base)
				if err != nil {
					return err
				}
				if err := l.p.markEmpty(p); err != nil {
					return err
				}
			}
		}
		setMapping(item, "env_file", &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Content: []*yaml.Node{scalar("/dev/null")}})
		for i, entry := range entries {
			copy, err := l.stage(ctx, originals[i], projectDir)
			if err != nil {
				return err
			}
			entry.Value = copy
		}
	}
	return nil
}
func scalar(s string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s} }
func mappingValue(n *yaml.Node, key string) *yaml.Node {
	if n.Kind == yaml.AliasNode {
		return mappingValue(n.Alias, key)
	}
	if n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}
func setMapping(n *yaml.Node, key string, value *yaml.Node) {
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			n.Content[i+1] = value
			return
		}
	}
	n.Content = append(n.Content, scalar(key), value)
}
func remoteContext(path string) bool {
	return strings.Contains(path, "://") || strings.HasPrefix(path, "git@") || strings.HasPrefix(path, "github.com/") || strings.HasPrefix(path, "git:") || strings.HasPrefix(path, "service:") || strings.Contains(path, ":") && !filepath.IsAbs(path)
}

// Expand YAML aliases/merge keys before inspecting include/extends. Retain
// custom Compose tags (!reset/!override), and bound alias expansion by bytes.
func expandYAML(ctx context.Context, n *yaml.Node, stack map[*yaml.Node]bool, used *int64, max int64) (*yaml.Node, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if stack[n] {
		return nil, fmt.Errorf("cyclic YAML alias in Compose input")
	}
	stack[n] = true
	defer delete(stack, n)
	*used += int64(len(n.Value) + 64)
	if *used > max {
		return nil, fmt.Errorf("expanded Compose YAML exceeds maximum %d bytes", max)
	}
	if n.Kind == yaml.AliasNode {
		return expandYAML(ctx, n.Alias, stack, used, max)
	}
	clone := *n
	clone.Anchor = ""
	clone.Alias = nil
	clone.Content = nil
	for _, child := range n.Content {
		copy, err := expandYAML(ctx, child, stack, used, max)
		if err != nil {
			return nil, err
		}
		clone.Content = append(clone.Content, copy)
	}
	if n.Kind != yaml.MappingNode {
		return &clone, nil
	}
	explicit := map[string]bool{}
	for i := 0; i+1 < len(clone.Content); i += 2 {
		if clone.Content[i].Value != "<<" {
			explicit[clone.Content[i].Value] = true
		}
	}
	content := []*yaml.Node{}
	for i := 0; i+1 < len(clone.Content); i += 2 {
		key, value := clone.Content[i], clone.Content[i+1]
		if key.Value != "<<" {
			content = append(content, key, value)
			continue
		}
		maps := []*yaml.Node{value}
		if value.Kind == yaml.SequenceNode {
			maps = value.Content
		}
		for _, mapping := range maps {
			if mapping.Kind != yaml.MappingNode {
				return nil, fmt.Errorf("invalid YAML merge in Compose input")
			}
			for j := 0; j+1 < len(mapping.Content); j += 2 {
				k, v := mapping.Content[j], mapping.Content[j+1]
				if !explicit[k.Value] {
					explicit[k.Value] = true
					content = append(content, k, v)
				}
			}
		}
	}
	clone.Content = content
	return &clone, nil
}
