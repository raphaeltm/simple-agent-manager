// Command go-optional-fields enforces the mechanical part of
// .claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md for Go.
//
// The incident: upsertWorkspaceRuntime(..., opts ...workspaceRuntimeOpts) guarded every
// string option (`if opt.X != "" { runtime.X = opt.X }`) but copied the one bool
// unconditionally (`runtime.Lightweight = opt.Lightweight`). A caller that passed no
// options therefore cleared the flag on an existing workspace.
//
// The check reports, for an options value, an assignment of one of its non-string scalar
// fields (bool, integer, float, time.Duration, or a named type over one of those) onto
// existing state when
//
//   - the assignment is not inside an `if` whose condition mentions that field
//     (unconditional copy: absence overwrites), or
//   - the only guard is the field's own truthiness (`if opt.F {`, `if opt.F != 0 {`),
//     which makes the field impossible to set back to false or zero.
//
// An options value is a variadic parameter `opts ...T` (and anything bound from opts[i]
// or ranged over it), or a parameter whose struct type name ends in Opts, Options, Opt,
// Patch, Override(s), Update or Changes. Assignments onto a variable the function itself
// created from a composite literal or new() are construction, not overwrite, and are not
// reported. A line may opt out with `//sam:optional-field-ok <reason>` on it or above it.
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
	"regexp"
	"sort"
	"strings"
)

const ruleFile = ".claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md"

var optionsTypeName = regexp.MustCompile(`(?i)(opts|options|opt|patch|overrides?|update|changes)$`)

var scalarIdents = map[string]bool{
	"bool": true, "int": true, "int8": true, "int16": true, "int32": true, "int64": true,
	"uint": true, "uint8": true, "uint16": true, "uint32": true, "uint64": true, "uintptr": true,
	"float32": true, "float64": true, "byte": true, "rune": true,
}

var scalarSelectors = map[string]bool{"time.Duration": true, "time.Month": true, "time.Weekday": true}

var skippedDirs = map[string]bool{".git": true, "node_modules": true, "vendor": true, "testdata": true, "dist": true}

// Finding is one reported assignment.
type Finding struct {
	Pos     token.Position
	Message string
}

type pkgIndex struct {
	structs map[string]map[string]ast.Expr
	named   map[string]ast.Expr // named non-struct types: underlying expression
}

func indexPackage(files []*ast.File) pkgIndex {
	index := pkgIndex{structs: map[string]map[string]ast.Expr{}, named: map[string]ast.Expr{}}
	for _, file := range files {
		for _, decl := range file.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.TYPE {
				continue
			}
			for _, spec := range gen.Specs {
				typeSpec := spec.(*ast.TypeSpec)
				st, ok := typeSpec.Type.(*ast.StructType)
				if !ok {
					index.named[typeSpec.Name.Name] = typeSpec.Type
					continue
				}
				fields := map[string]ast.Expr{}
				for _, field := range st.Fields.List {
					for _, name := range field.Names {
						fields[name.Name] = field.Type
					}
				}
				index.structs[typeSpec.Name.Name] = fields
			}
		}
	}
	return index
}

// scalarKind names a type whose zero value is a real value ("false", "0"), or "" when the
// type has a spare zero (string), can express absence (pointer, slice, map), or is unknown.
func (index pkgIndex) scalarKind(expr ast.Expr, depth int) string {
	switch t := expr.(type) {
	case *ast.Ident:
		if scalarIdents[t.Name] {
			return t.Name
		}
		if underlying, ok := index.named[t.Name]; ok && depth < 4 {
			if kind := index.scalarKind(underlying, depth+1); kind != "" {
				return t.Name
			}
		}
	case *ast.SelectorExpr:
		if pkg, ok := t.X.(*ast.Ident); ok && scalarSelectors[pkg.Name+"."+t.Sel.Name] {
			return pkg.Name + "." + t.Sel.Name
		}
	}
	return ""
}

func structName(expr ast.Expr) string {
	if star, ok := expr.(*ast.StarExpr); ok {
		expr = star.X
	}
	if ident, ok := expr.(*ast.Ident); ok {
		return ident.Name
	}
	return ""
}

// Stats shows the check is not vacuous: how much option handling it actually examined.
type Stats struct {
	Files, OptionFuncs, ScalarCopies int
}

type checker struct {
	stats    *Stats
	fset     *token.FileSet
	index    pkgIndex
	findings []Finding
	comments map[string]map[int]bool // file -> lines carrying the opt-out marker
}

func (c *checker) optedOut(pos token.Position) bool {
	lines := c.comments[pos.Filename]
	return lines[pos.Line] || lines[pos.Line-1]
}

// optionVars maps each variable that holds an options value in fn to its struct type.
func (c *checker) optionVars(fn *ast.FuncDecl) map[string]string {
	vars := map[string]string{}
	variadic := map[string]string{}
	if fn.Type.Params == nil {
		return vars
	}
	for _, field := range fn.Type.Params.List {
		if ellipsis, ok := field.Type.(*ast.Ellipsis); ok {
			if name := structName(ellipsis.Elt); name != "" && c.index.structs[name] != nil {
				for _, param := range field.Names {
					variadic[param.Name] = name
				}
			}
			continue
		}
		name := structName(field.Type)
		if name == "" || c.index.structs[name] == nil || !optionsTypeName.MatchString(name) {
			continue
		}
		for _, param := range field.Names {
			vars[param.Name] = name
		}
	}
	if len(variadic) == 0 || fn.Body == nil {
		return vars
	}
	ast.Inspect(fn.Body, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.AssignStmt:
			for i, rhs := range n.Rhs {
				if i >= len(n.Lhs) {
					break
				}
				index, ok := rhs.(*ast.IndexExpr)
				if !ok {
					continue
				}
				if slice, ok := index.X.(*ast.Ident); ok && variadic[slice.Name] != "" {
					if lhs, ok := n.Lhs[i].(*ast.Ident); ok {
						vars[lhs.Name] = variadic[slice.Name]
					}
				}
			}
		case *ast.RangeStmt:
			if slice, ok := n.X.(*ast.Ident); ok && variadic[slice.Name] != "" {
				if value, ok := n.Value.(*ast.Ident); ok {
					vars[value.Name] = variadic[slice.Name]
				}
			}
		}
		return true
	})
	return vars
}

func isConstruction(expr ast.Expr) bool {
	switch e := expr.(type) {
	case *ast.CompositeLit:
		return true
	case *ast.UnaryExpr:
		_, ok := e.X.(*ast.CompositeLit)
		return e.Op == token.AND && ok
	case *ast.CallExpr:
		ident, ok := e.Fun.(*ast.Ident)
		return ok && ident.Name == "new"
	}
	return false
}

// freshVars are local variables every assignment of which builds a new value.
func freshVars(fn *ast.FuncDecl) map[string]bool {
	fresh := map[string]bool{}
	tainted := map[string]bool{}
	note := func(name string, rhs ast.Expr) {
		if rhs != nil && isConstruction(rhs) {
			fresh[name] = true
		} else {
			tainted[name] = true
		}
	}
	ast.Inspect(fn.Body, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.AssignStmt:
			for i, lhs := range n.Lhs {
				ident, ok := lhs.(*ast.Ident)
				if !ok {
					continue
				}
				var rhs ast.Expr
				if len(n.Rhs) == len(n.Lhs) {
					rhs = n.Rhs[i]
				}
				note(ident.Name, rhs)
			}
		case *ast.ValueSpec:
			for i, name := range n.Names {
				var rhs ast.Expr
				if i < len(n.Values) {
					rhs = n.Values[i]
				}
				if rhs == nil {
					fresh[name.Name] = true // `var x T`: a zero value, built here
					continue
				}
				note(name.Name, rhs)
			}
		}
		return true
	})
	for name := range tainted {
		delete(fresh, name)
	}
	return fresh
}

func rootIdent(expr ast.Expr) *ast.Ident {
	for {
		switch e := expr.(type) {
		case *ast.Ident:
			return e
		case *ast.SelectorExpr:
			expr = e.X
		case *ast.IndexExpr:
			expr = e.X
		case *ast.StarExpr:
			expr = e.X
		case *ast.ParenExpr:
			expr = e.X
		default:
			return nil
		}
	}
}

func mentionsField(expr ast.Expr, optVar, field string) bool {
	found := false
	ast.Inspect(expr, func(node ast.Node) bool {
		if sel, ok := node.(*ast.SelectorExpr); ok && sel.Sel.Name == field {
			if ident, ok := sel.X.(*ast.Ident); ok && ident.Name == optVar {
				found = true
			}
		}
		return !found
	})
	return found
}

// isTruthinessGuard reports `opt.F` or `opt.F != 0` / `opt.F > 0`: a guard that skips the
// zero value, so the field can never be set back to false or zero.
func isTruthinessGuard(cond ast.Expr, optVar, field string) bool {
	isField := func(expr ast.Expr) bool {
		sel, ok := expr.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != field {
			return false
		}
		ident, ok := sel.X.(*ast.Ident)
		return ok && ident.Name == optVar
	}
	if paren, ok := cond.(*ast.ParenExpr); ok {
		cond = paren.X
	}
	if isField(cond) {
		return true
	}
	binary, ok := cond.(*ast.BinaryExpr)
	if !ok || (binary.Op != token.NEQ && binary.Op != token.GTR) {
		return false
	}
	lit, ok := binary.Y.(*ast.BasicLit)
	return ok && isField(binary.X) && (lit.Value == "0" || lit.Value == "0.0")
}

type guard struct {
	cond   ast.Expr
	inBody bool // true in the if-body, false in an else branch
}

func (c *checker) checkFunc(fn *ast.FuncDecl) {
	if fn.Body == nil {
		return
	}
	optVars := c.optionVars(fn)
	if len(optVars) == 0 {
		return
	}
	c.stats.OptionFuncs++
	fresh := freshVars(fn)
	var walk func(node ast.Node, guards []guard)
	walk = func(node ast.Node, guards []guard) {
		if node == nil {
			return
		}
		switch n := node.(type) {
		case *ast.IfStmt:
			walk(n.Init, guards)
			walk(n.Body, append(append([]guard{}, guards...), guard{n.Cond, true}))
			walk(n.Else, append(append([]guard{}, guards...), guard{n.Cond, false}))
			return
		case *ast.FuncLit:
			walk(n.Body, guards)
			return
		case *ast.AssignStmt:
			c.checkAssign(n, optVars, fresh, guards)
		}
		ast.Inspect(node, func(child ast.Node) bool {
			if child == node {
				return true
			}
			switch child.(type) {
			case *ast.IfStmt, *ast.FuncLit, *ast.AssignStmt, *ast.BlockStmt, *ast.ForStmt, *ast.RangeStmt,
				*ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.CaseClause, *ast.SelectStmt, *ast.CommClause,
				*ast.LabeledStmt:
				walk(child, guards)
				return false
			}
			return true
		})
	}
	walk(fn.Body, nil)
}

func (c *checker) checkAssign(n *ast.AssignStmt, optVars map[string]string, fresh map[string]bool, guards []guard) {
	if n.Tok != token.ASSIGN || len(n.Lhs) != len(n.Rhs) {
		return
	}
	for i, rhs := range n.Rhs {
		sel, ok := rhs.(*ast.SelectorExpr)
		if !ok {
			continue
		}
		optIdent, ok := sel.X.(*ast.Ident)
		if !ok || optVars[optIdent.Name] == "" {
			continue
		}
		typeName := optVars[optIdent.Name]
		fieldType, ok := c.index.structs[typeName][sel.Sel.Name]
		if !ok {
			continue
		}
		kind := c.index.scalarKind(fieldType, 0)
		if kind == "" {
			continue
		}
		target, ok := n.Lhs[i].(*ast.SelectorExpr)
		if !ok {
			continue
		}
		if root := rootIdent(target); root == nil || fresh[root.Name] {
			continue
		}
		c.stats.ScalarCopies++
		pos := c.fset.Position(n.Pos())
		if c.optedOut(pos) {
			continue
		}
		field := sel.Sel.Name
		guarded, truthiness := false, false
		for _, g := range guards {
			if mentionsField(g.cond, optIdent.Name, field) {
				guarded = true
				truthiness = g.inBody && isTruthinessGuard(g.cond, optIdent.Name, field)
			}
		}
		lhs := exprString(target)
		switch {
		case !guarded:
			c.findings = append(c.findings, Finding{pos, fmt.Sprintf(
				"%s = %s.%s copies %s.%s (%s) onto existing state with no \"not supplied\" check, so a caller that omits it overwrites the stored value with %s. Make the field a pointer (nil = not supplied) and assign only when it is set. See %s",
				lhs, optIdent.Name, field, typeName, field, kind, zeroOf(kind), ruleFile)})
		case truthiness:
			c.findings = append(c.findings, Finding{pos, fmt.Sprintf(
				"%s is guarded only by the truthiness of %s.%s (%s), so it can never be set back to %s. Make the field a pointer (nil = not supplied). See %s",
				lhs, optIdent.Name, field, kind, zeroOf(kind), ruleFile)})
		}
	}
}

func zeroOf(kind string) string {
	if kind == "bool" {
		return "false"
	}
	return "its zero value"
}

func exprString(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.SelectorExpr:
		return exprString(e.X) + "." + e.Sel.Name
	case *ast.StarExpr:
		return "*" + exprString(e.X)
	case *ast.IndexExpr:
		return exprString(e.X) + "[...]"
	case *ast.ParenExpr:
		return "(" + exprString(e.X) + ")"
	}
	return "<expr>"
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
		comments := map[string]map[int]bool{}
		for _, path := range paths {
			file, err := parser.ParseFile(fset, path, nil, parser.ParseComments|parser.SkipObjectResolution)
			if err != nil {
				return nil, fmt.Errorf("parse %s: %w", path, err)
			}
			parsed = append(parsed, file)
			lines := map[int]bool{}
			for _, group := range file.Comments {
				for _, comment := range group.List {
					if strings.Contains(comment.Text, "sam:optional-field-ok") {
						lines[fset.Position(comment.Pos()).Line] = true
					}
				}
			}
			comments[path] = lines
		}
		stats.Files += len(parsed)
		// Group by package name: a directory can hold a main package and others only in
		// tests, which are skipped above.
		c := &checker{stats: stats, fset: fset, index: indexPackage(parsed), comments: comments}
		for _, file := range parsed {
			for _, decl := range file.Decls {
				if fn, ok := decl.(*ast.FuncDecl); ok {
					c.checkFunc(fn)
				}
			}
		}
		findings = append(findings, c.findings...)
	}
	sort.Slice(findings, func(i, j int) bool {
		if findings[i].Pos.Filename != findings[j].Pos.Filename {
			return findings[i].Pos.Filename < findings[j].Pos.Filename
		}
		return findings[i].Pos.Line < findings[j].Pos.Line
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
	fmt.Printf("go-optional-fields: %d finding(s); examined %d Go file(s), %d function(s) taking options, %d scalar option copies\n",
		total, stats.Files, stats.OptionFuncs, stats.ScalarCopies)
	if total > 0 && !*advisory {
		os.Exit(1)
	}
}
