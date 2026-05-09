// Package repomap generates a compact textual representation of a code
// repository's structure by extracting top-level declarations from source
// files. Go files are parsed with go/parser+go/ast; other languages use
// simple regex extraction.
package repomap

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Options configures repo map generation.
type Options struct {
	// TokenBudget is the approximate max character length of the output.
	// Files are sorted by declaration count; lower-value files are dropped
	// when the budget is exceeded. 0 means 4000.
	TokenBudget int
}

// sourceExts lists file extensions we extract declarations from.
var sourceExts = map[string]bool{
	".go":   true,
	".ts":   true,
	".tsx":  true,
	".js":   true,
	".jsx":  true,
	".py":   true,
	".rs":   true,
	".java": true,
	".c":    true,
	".cpp":  true,
	".h":    true,
}

// skipDirs are directories that are always excluded from scanning.
var skipDirs = map[string]bool{
	".git":         true,
	"node_modules": true,
	"vendor":       true,
	"dist":         true,
	"__pycache__":  true,
	".next":        true,
	"build":        true,
}

// decl is a single extracted declaration.
type decl struct {
	Line    int
	Summary string
}

// fileEntry holds declarations for a single file.
type fileEntry struct {
	Path  string
	Decls []decl
}

// Generate produces a repo map for the directory rooted at dir.
func Generate(dir string, opts *Options) (string, error) {
	budget := 4000
	if opts != nil && opts.TokenBudget > 0 {
		budget = opts.TokenBudget
	}

	dir, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("repomap: abs path: %w", err)
	}

	var entries []fileEntry

	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d.IsDir() {
			if skipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		ext := strings.ToLower(filepath.Ext(d.Name()))
		if !sourceExts[ext] {
			return nil
		}

		relPath, _ := filepath.Rel(dir, path)
		decls := extractDeclarations(path, ext)
		if len(decls) > 0 {
			entries = append(entries, fileEntry{Path: relPath, Decls: decls})
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("repomap: walk: %w", err)
	}

	// Sort by declaration count descending so the most important files
	// survive truncation.
	sort.Slice(entries, func(i, j int) bool {
		return len(entries[i].Decls) > len(entries[j].Decls)
	})

	return renderWithBudget(entries, budget), nil
}

// renderWithBudget formats entries, dropping tail entries to stay within budget.
func renderWithBudget(entries []fileEntry, budget int) string {
	var b strings.Builder
	for _, e := range entries {
		section := formatEntry(e)
		if b.Len()+len(section) > budget && b.Len() > 0 {
			break
		}
		b.WriteString(section)
	}
	return b.String()
}

// formatEntry formats a single file's declarations.
func formatEntry(e fileEntry) string {
	var b strings.Builder
	b.WriteString(e.Path)
	b.WriteString(":\n")
	for _, d := range e.Decls {
		fmt.Fprintf(&b, "  %s :%d\n", d.Summary, d.Line)
	}
	b.WriteByte('\n')
	return b.String()
}

// extractDeclarations dispatches to the appropriate parser based on extension.
func extractDeclarations(path, ext string) []decl {
	if ext == ".go" {
		return extractGo(path)
	}
	return extractRegex(path, ext)
}

// extractGo parses a Go file using go/parser and extracts top-level
// function signatures, type declarations, and constants/variables.
func extractGo(path string) []decl {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
	if err != nil {
		return nil
	}

	var decls []decl
	for _, node := range f.Decls {
		switch d := node.(type) {
		case *ast.FuncDecl:
			decls = append(decls, decl{
				Line:    fset.Position(d.Pos()).Line,
				Summary: formatFuncDecl(d),
			})
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					decls = append(decls, decl{
						Line:    fset.Position(s.Pos()).Line,
						Summary: formatTypeSpec(s),
					})
				case *ast.ValueSpec:
					keyword := "var"
					if d.Tok == token.CONST {
						keyword = "const"
					}
					for _, name := range s.Names {
						if name.IsExported() {
							decls = append(decls, decl{
								Line:    fset.Position(name.Pos()).Line,
								Summary: keyword + " " + name.Name,
							})
						}
					}
				}
			}
		}
	}
	return decls
}

// formatFuncDecl produces a compact function signature.
func formatFuncDecl(d *ast.FuncDecl) string {
	var b strings.Builder
	b.WriteString("func ")
	if d.Recv != nil && len(d.Recv.List) > 0 {
		b.WriteString("(")
		b.WriteString(exprName(d.Recv.List[0].Type))
		b.WriteString(") ")
	}
	b.WriteString(d.Name.Name)
	b.WriteString("(")
	b.WriteString(paramList(d.Type.Params))
	b.WriteString(")")
	if d.Type.Results != nil && len(d.Type.Results.List) > 0 {
		b.WriteString(" ")
		results := paramList(d.Type.Results)
		if len(d.Type.Results.List) > 1 {
			b.WriteString("(")
			b.WriteString(results)
			b.WriteString(")")
		} else {
			b.WriteString(results)
		}
	}
	return b.String()
}

// formatTypeSpec produces a compact type summary.
func formatTypeSpec(s *ast.TypeSpec) string {
	switch s.Type.(type) {
	case *ast.InterfaceType:
		return "type " + s.Name.Name + " interface"
	case *ast.StructType:
		return "type " + s.Name.Name + " struct"
	default:
		return "type " + s.Name.Name
	}
}

// paramList renders a parameter list compactly (names only, types shortened).
func paramList(fl *ast.FieldList) string {
	if fl == nil || len(fl.List) == 0 {
		return ""
	}
	var parts []string
	for _, f := range fl.List {
		typeName := exprName(f.Type)
		if len(f.Names) == 0 {
			parts = append(parts, typeName)
		} else {
			for _, n := range f.Names {
				parts = append(parts, n.Name+" "+typeName)
			}
		}
	}
	return strings.Join(parts, ", ")
}

// exprName extracts a short name from a type expression.
func exprName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return "*" + exprName(t.X)
	case *ast.SelectorExpr:
		return exprName(t.X) + "." + t.Sel.Name
	case *ast.ArrayType:
		return "[]" + exprName(t.Elt)
	case *ast.MapType:
		return "map[" + exprName(t.Key) + "]" + exprName(t.Value)
	case *ast.InterfaceType:
		return "interface{}"
	case *ast.Ellipsis:
		return "..." + exprName(t.Elt)
	case *ast.FuncType:
		return "func"
	case *ast.ChanType:
		return "chan"
	case *ast.IndexExpr:
		return exprName(t.X) + "[" + exprName(t.Index) + "]"
	default:
		return "any"
	}
}

// Regex patterns for non-Go languages.
var (
	tsPatterns = []*regexp.Regexp{
		regexp.MustCompile(`^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)`),
		regexp.MustCompile(`^export\s+(?:default\s+)?class\s+(\w+)`),
		regexp.MustCompile(`^export\s+(?:default\s+)?interface\s+(\w+)`),
		regexp.MustCompile(`^export\s+(?:default\s+)?type\s+(\w+)`),
		regexp.MustCompile(`^export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)`),
		regexp.MustCompile(`^(?:async\s+)?function\s+(\w+)`),
		regexp.MustCompile(`^class\s+(\w+)`),
		regexp.MustCompile(`^interface\s+(\w+)`),
		regexp.MustCompile(`^type\s+(\w+)`),
	}
	pyPatterns = []*regexp.Regexp{
		regexp.MustCompile(`^def\s+(\w+)\s*\(`),
		regexp.MustCompile(`^async\s+def\s+(\w+)\s*\(`),
		regexp.MustCompile(`^class\s+(\w+)`),
	}
	rsPatterns = []*regexp.Regexp{
		regexp.MustCompile(`^pub\s+(?:async\s+)?fn\s+(\w+)`),
		regexp.MustCompile(`^pub\s+struct\s+(\w+)`),
		regexp.MustCompile(`^pub\s+enum\s+(\w+)`),
		regexp.MustCompile(`^pub\s+trait\s+(\w+)`),
		regexp.MustCompile(`^(?:async\s+)?fn\s+(\w+)`),
		regexp.MustCompile(`^struct\s+(\w+)`),
		regexp.MustCompile(`^enum\s+(\w+)`),
		regexp.MustCompile(`^trait\s+(\w+)`),
		regexp.MustCompile(`^impl(?:\s+\w+)?\s+(?:for\s+)?(\w+)`),
	}
	javaPatterns = []*regexp.Regexp{
		regexp.MustCompile(`^\s*(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+(\w+)`),
		regexp.MustCompile(`^\s*(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(`),
	}
	cPatterns = []*regexp.Regexp{
		regexp.MustCompile(`^(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:unsigned\s+)?(?:struct\s+)?(?:\w+\s*\*?\s+)+(\w+)\s*\(`),
		regexp.MustCompile(`^typedef\s+(?:struct|enum|union)\s+\w*\s*\{`),
		regexp.MustCompile(`^struct\s+(\w+)\s*\{`),
		regexp.MustCompile(`^enum\s+(\w+)\s*\{`),
	}
)

// extractRegex uses regex patterns to extract declarations from non-Go files.
func extractRegex(path, ext string) []decl {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	patterns := patternsForExt(ext)
	if len(patterns) == 0 {
		return nil
	}

	lines := strings.Split(string(data), "\n")
	var decls []decl
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "/*") {
			continue
		}
		for _, re := range patterns {
			m := re.FindStringSubmatch(trimmed)
			if m != nil {
				summary := buildRegexSummary(trimmed, m, ext)
				decls = append(decls, decl{Line: i + 1, Summary: summary})
				break
			}
		}
	}
	return decls
}

// patternsForExt returns regex patterns for a file extension.
func patternsForExt(ext string) []*regexp.Regexp {
	switch ext {
	case ".ts", ".tsx", ".js", ".jsx":
		return tsPatterns
	case ".py":
		return pyPatterns
	case ".rs":
		return rsPatterns
	case ".java":
		return javaPatterns
	case ".c", ".cpp", ".h":
		return cPatterns
	default:
		return nil
	}
}

// buildRegexSummary creates a compact declaration summary from a regex match.
func buildRegexSummary(line string, match []string, ext string) string {
	// For TS/JS: try to produce a clean summary from the matched line.
	// Trim everything after the opening brace or arrow.
	summary := strings.TrimSpace(line)
	if idx := strings.Index(summary, "{"); idx > 0 {
		summary = strings.TrimSpace(summary[:idx])
	}
	// Cap length to keep summaries compact.
	if len(summary) > 80 {
		summary = summary[:77] + "..."
	}
	return summary
}
