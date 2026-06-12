package deploy

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func GenerateCaddyfile(routes []RouteTarget) string {
	var builder strings.Builder
	builder.WriteString("# Managed by SAM deployment agent.\n")

	ordered := append([]RouteTarget(nil), routes...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].Hostname < ordered[j].Hostname
	})

	for _, route := range ordered {
		builder.WriteString("\n")
		builder.WriteString(route.Hostname)
		builder.WriteString(" {\n")
		builder.WriteString("\tencode zstd gzip\n")
		builder.WriteString(fmt.Sprintf("\treverse_proxy 127.0.0.1:%d\n", route.HostPort))
		builder.WriteString("}\n")
	}

	return builder.String()
}

func writeFileAtomic(path string, content string, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create parent directory: %w", err)
	}

	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("rename temp file: %w", err)
	}
	return nil
}
