// Command go-optional-fields enforces the mechanical part of
// .claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md for Go.
//
// The incident: upsertWorkspaceRuntime(..., opts ...workspaceRuntimeOpts) guarded every
// string option (`if opt.X != "" { runtime.X = opt.X }`) but copied the one bool
// unconditionally (`runtime.Lightweight = opt.Lightweight`). A caller that passed no
// options therefore cleared the flag on an existing workspace.
//
// What is an options value: a parameter or receiver whose struct type name ends in Opts,
// Options, Opt, Patch or Override(s) (aliases, generics and embedded fields resolved within
// the package); a variadic parameter of such a type or named opts/options/patches; and any
// opts[i], *opts[i] or local bound from one.
//
// What is reported: a non-string scalar field (bool, integer, float, time.Duration, or a
// named type over one) of an options value written onto existing state, directly or through
// an expression (`!o.F`, `time.Duration(o.F)`), or as part of a struct literal that replaces
// a value (`*r = R{F: o.F}`), when
//
//   - no enclosing condition checks that the field was supplied (a mention of the field or a
//     presence flag such as HasF in an if, case or early-return condition; else and default
//     branches do not count, nor does comparing the field with the target itself), or
//   - the only check is the field's own truthiness (`if o.F`, `o.F > 0`, `!o.F` before a
//     return), which makes it impossible to set back to false or zero; this also covers
//     `if o.F { r.F = true }`.
//
// Writes onto a local the function builds itself are construction and are not reported.
// A deliberate full replacement opts out with `//sam:optional-field-ok <reason>` on the line
// above the statement or trailing it.
//
// Not covered: writes through helper calls (`set(&r.F, o.F)`), options types declared in
// another package, and struct literals stored into maps or slices (usually creates).
//
// Usage: go-optional-fields [-advisory] <dir>...   (exit 1 on findings unless -advisory)
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const ruleFile = ".claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md"

var skippedDirs = map[string]bool{".git": true, "node_modules": true, "vendor": true, "testdata": true, "dist": true}

// Finding is one reported assignment.
type Finding struct {
	Pos     token.Position
	Message string
}

// Stats shows the check is not vacuous: how much option handling it actually examined.
type Stats struct {
	Files, OptionFuncs, ScalarCopies, FreshSkipped, OptedOut int
}

type checker struct {
	stats    *Stats
	fset     *token.FileSet
	index    pkgIndex
	findings []Finding
	optOut   map[string]map[int]bool // file -> lines covered by an opt-out marker
}

func (c *checker) optedOut(pos token.Position) bool {
	return c.optOut[pos.Filename][pos.Line]
}

func (c *checker) report(pos token.Position, message string) {
	c.findings = append(c.findings, Finding{pos, message})
}

func (c *checker) checkFile(file *ast.File) {
	imports := importNames(file)
	run := func(recv, params *ast.FieldList, body *ast.BlockStmt) {
		if body == nil {
			return
		}
		s := scope{vars: map[string]string{}, slices: map[string]string{}}
		c.addParams(s, recv)
		c.addParams(s, params)
		s.bindAliases(body)
		s.fresh = freshVars([]*ast.FieldList{recv, params}, body, s.vars, imports)
		c.checkFunc(s, body)
	}
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			run(d.Recv, d.Type.Params, d.Body)
		case *ast.GenDecl:
			// Package-level function literals: var apply = func(r *R, o Opts) { ... }
			for _, spec := range d.Specs {
				value, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for _, expr := range value.Values {
					if lit, ok := expr.(*ast.FuncLit); ok {
						run(nil, lit.Type.Params, lit.Body)
					}
				}
			}
		}
	}
}

// CheckDir checks every package directory under root and returns the findings.
func CheckDir(root string, stats *Stats) ([]Finding, error) {
	byDir := map[string][]string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if path != root && (skippedDirs[entry.Name()] || strings.HasPrefix(entry.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go") {
			byDir[filepath.Dir(path)] = append(byDir[filepath.Dir(path)], path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	var findings []Finding
	for _, paths := range byDir {
		fset := token.NewFileSet()
		var parsed []*ast.File
		optOut := map[string]map[int]bool{}
		for _, path := range paths {
			source, err := os.ReadFile(path)
			if err != nil {
				return nil, err
			}
			file, err := parser.ParseFile(fset, path, source, parser.ParseComments|parser.SkipObjectResolution)
			if err != nil {
				return nil, fmt.Errorf("parse %s: %w", path, err)
			}
			parsed = append(parsed, file)
			optOut[path] = optOutLines(fset, file, source)
		}
		stats.Files += len(parsed)
		c := &checker{stats: stats, fset: fset, index: indexPackage(parsed), optOut: optOut}
		for _, file := range parsed {
			c.checkFile(file)
		}
		findings = append(findings, c.findings...)
	}
	sort.SliceStable(findings, func(i, j int) bool {
		a, b := findings[i].Pos, findings[j].Pos
		if a.Filename != b.Filename {
			return a.Filename < b.Filename
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		if a.Column != b.Column {
			return a.Column < b.Column
		}
		return findings[i].Message < findings[j].Message
	})
	return findings, nil
}

func main() {
	advisory := flag.Bool("advisory", false, "report findings without failing")
	flag.Parse()
	if flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: go-optional-fields [-advisory] <dir>...")
		os.Exit(2)
	}
	total := 0
	stats := &Stats{}
	for _, dir := range flag.Args() {
		findings, err := CheckDir(dir, stats)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		for _, finding := range findings {
			fmt.Printf("%s:%d: %s\n", finding.Pos.Filename, finding.Pos.Line, finding.Message)
		}
		total += len(findings)
	}
	fmt.Printf("go-optional-fields: %d finding(s); examined %d Go file(s), %d function(s) taking options, %d scalar option copies onto existing state, %d onto values built locally, %d opted out\n",
		total, stats.Files, stats.OptionFuncs, stats.ScalarCopies, stats.FreshSkipped, stats.OptedOut)
	if total > 0 && !*advisory {
		os.Exit(1)
	}
}
