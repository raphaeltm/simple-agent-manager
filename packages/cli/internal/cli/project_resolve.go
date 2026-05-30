package cli

import (
	"context"
	"fmt"
	"strings"
)

const minPrefixLen = 5

// ResolveProject resolves a user-provided reference to a project ID and name.
// Resolution order:
//  1. If ref looks like a ULID (26 chars, uppercase alphanumeric), use as-is
//  2. If ref is a short prefix (5+ chars, starts like a ULID), find unique match by ID prefix
//  3. If ref is a non-empty string, find by case-insensitive name match
//  4. If ref is empty and config has ActiveProjectID, use that
//  5. If ref is empty and no config, return error with hint
func ResolveProject(ctx context.Context, client APIClient, ref string, config *CLIConfig) (string, string, error) {
	ref = strings.TrimSpace(ref)

	if ref == "" {
		return resolveFromConfig(config)
	}

	if isULID(ref) {
		return ref, "", nil
	}

	projects, err := client.ListProjects(ctx)
	if err != nil {
		return "", "", fmt.Errorf("failed to list projects: %w", err)
	}

	if isULIDPrefix(ref) {
		return matchByPrefix(ref, projects.Projects)
	}

	return matchByName(ref, projects.Projects)
}

func resolveFromConfig(config *CLIConfig) (string, string, error) {
	if config != nil && config.ActiveProjectID != "" {
		return config.ActiveProjectID, config.ActiveProjectName, nil
	}
	return "", "", fmt.Errorf("no project specified. Use --project <name> or run `sam project use` to set a default")
}

func isULID(s string) bool {
	if len(s) != 26 {
		return false
	}
	for _, c := range s {
		if !isBase32Char(c) {
			return false
		}
	}
	return true
}

func isULIDPrefix(s string) bool {
	if len(s) < minPrefixLen {
		return false
	}
	for _, c := range s {
		if !isBase32Char(c) {
			return false
		}
	}
	return true
}

func isBase32Char(c rune) bool {
	return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z')
}

func matchByPrefix(prefix string, projects []Project) (string, string, error) {
	upper := strings.ToUpper(prefix)
	var matches []Project
	for _, p := range projects {
		if strings.HasPrefix(strings.ToUpper(p.ID), upper) {
			matches = append(matches, p)
		}
	}
	switch len(matches) {
	case 0:
		return "", "", fmt.Errorf("no project found with ID prefix %q", prefix)
	case 1:
		return matches[0].ID, matches[0].Name, nil
	default:
		return "", "", ambiguousError(prefix, matches)
	}
}

func matchByName(name string, projects []Project) (string, string, error) {
	lower := strings.ToLower(name)
	var matches []Project
	for _, p := range projects {
		if strings.ToLower(p.Name) == lower {
			matches = append(matches, p)
		}
	}
	switch len(matches) {
	case 0:
		return "", "", fmt.Errorf("no project found with name %q. Run `sam projects` to list available projects", name)
	case 1:
		return matches[0].ID, matches[0].Name, nil
	default:
		return "", "", ambiguousError(name, matches)
	}
}

func ambiguousError(ref string, matches []Project) error {
	var names []string
	for _, m := range matches {
		names = append(names, fmt.Sprintf("%s (%s)", m.Name, TruncateID(m.ID)))
	}
	return fmt.Errorf("multiple projects match %q: %s. Be more specific", ref, strings.Join(names, ", "))
}
