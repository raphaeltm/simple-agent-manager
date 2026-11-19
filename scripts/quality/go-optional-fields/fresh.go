package main

import (
	"go/ast"
	"go/token"
	"strings"
)

// freshVars are locals a function builds itself and never fills from existing state. Writing
// an options field onto one of them is construction, not an overwrite. A variable stops being
// fresh when it is assigned anything but a new value, has its address taken, is passed to a
// call, is written through (`*v = ...`), or is re-declared by a range, a closure parameter or
// a function parameter of the same name (names are tracked per function, not per block, so a
// shadow makes the check stricter, never looser).
func freshVars(params []*ast.FieldList, body *ast.BlockStmt, optionVars map[string]string, imports map[string]bool) map[string]bool {
	fresh := map[string]bool{}
	tainted := map[string]bool{}
	for _, list := range params {
		if list == nil {
			continue
		}
		for _, field := range list.List {
			for _, name := range field.Names {
				tainted[name.Name] = true
			}
		}
	}
	isNew := func(expr ast.Expr) bool {
		return isConstruction(expr, optionVars, imports)
	}
	note := func(name string, rhs ast.Expr) {
		if rhs != nil && isNew(rhs) {
			fresh[name] = true
		} else {
			tainted[name] = true
		}
	}
	ast.Inspect(body, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.AssignStmt:
			for i, lhs := range n.Lhs {
				if ident, ok := lhs.(*ast.Ident); ok {
					var rhs ast.Expr
					if len(n.Rhs) == len(n.Lhs) {
						rhs = n.Rhs[i]
					}
					note(ident.Name, rhs)
				} else if star, ok := lhs.(*ast.StarExpr); ok {
					if root := rootIdent(star.X); root != nil {
						tainted[root.Name] = true
					}
				}
			}
		case *ast.ValueSpec:
			for i, name := range n.Names {
				switch {
				case len(n.Values) == 0:
					fresh[name.Name] = true // `var x T`: a zero value built here
				case len(n.Values) == len(n.Names):
					note(name.Name, n.Values[i])
				default:
					tainted[name.Name] = true // var a, b = f()
				}
			}
		case *ast.RangeStmt:
			for _, expr := range []ast.Expr{n.Key, n.Value} {
				if ident, ok := expr.(*ast.Ident); ok {
					tainted[ident.Name] = true
				}
			}
		case *ast.FuncLit:
			for _, field := range n.Type.Params.List {
				for _, name := range field.Names {
					tainted[name.Name] = true
				}
			}
		case *ast.UnaryExpr:
			if n.Op == token.AND {
				if root := rootIdent(n.X); root != nil {
					tainted[root.Name] = true
				}
			}
		case *ast.CallExpr:
			for _, arg := range n.Args {
				if ident, ok := arg.(*ast.Ident); ok {
					tainted[ident.Name] = true
				}
			}
		}
		return true
	})
	for name := range tainted {
		delete(fresh, name)
	}
	return fresh
}

// isConstruction: a composite literal, &literal or new(T) whose values do not copy from
// existing state (they may use options values, literals, package-qualified names and calls).
func isConstruction(expr ast.Expr, optionVars map[string]string, imports map[string]bool) bool {
	switch e := expr.(type) {
	case *ast.UnaryExpr:
		return e.Op == token.AND && isConstruction(e.X, optionVars, imports)
	case *ast.CallExpr:
		ident, ok := e.Fun.(*ast.Ident)
		return ok && ident.Name == "new"
	case *ast.CompositeLit:
		for _, element := range e.Elts {
			value := element
			if kv, ok := element.(*ast.KeyValueExpr); ok {
				value = kv.Value
			}
			if copiesExisting(value, optionVars, imports) {
				return false
			}
		}
		return true
	}
	return false
}

// copiesExisting reports a field or index read from a variable that is neither an options
// value nor an imported package: `R{Name: old.Name}` copies existing state.
func copiesExisting(expr ast.Expr, optionVars map[string]string, imports map[string]bool) bool {
	found := false
	ast.Inspect(expr, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.SelectorExpr, *ast.IndexExpr:
			root := rootIdent(n.(ast.Expr))
			if root != nil && optionVars[root.Name] == "" && !imports[root.Name] {
				found = true
			}
			return false
		}
		return !found
	})
	return found
}

// importNames are the identifiers a file uses for imported packages.
func importNames(file *ast.File) map[string]bool {
	names := map[string]bool{}
	for _, spec := range file.Imports {
		if spec.Name != nil {
			names[spec.Name.Name] = true
			continue
		}
		path := strings.Trim(spec.Path.Value, `"`)
		names[path[strings.LastIndex(path, "/")+1:]] = true
	}
	return names
}

const optOutMarker = "sam:optional-field-ok"

// optOutLines finds `//sam:optional-field-ok <reason>` markers. A marker applies to the
// statement on the line after its comment block when the block starts its own line, or to the
// statement it trails on the same line. A marker with no reason does not count.
func optOutLines(fset *token.FileSet, file *ast.File, source []byte) map[int]bool {
	lines := strings.Split(string(source), "\n")
	result := map[int]bool{}
	for _, group := range file.Comments {
		first := group.List[0]
		text := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(first.Text, "//"), "/*"))
		if !strings.HasPrefix(text, optOutMarker) {
			continue
		}
		reason := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(text, optOutMarker), "*/"))
		if reason == "" && len(group.List) == 1 && !strings.Contains(first.Text, "\n") {
			continue
		}
		start := fset.Position(first.Pos())
		if start.Line-1 < len(lines) && strings.TrimSpace(lines[start.Line-1][:start.Column-1]) == "" {
			result[fset.Position(group.End()).Line+1] = true // own line: covers the next statement
		} else {
			result[start.Line] = true // trailing: covers the statement on this line
		}
	}
	return result
}
