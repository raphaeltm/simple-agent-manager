package main

import (
	"go/ast"
	"go/token"
	"regexp"
)

// optionsTypeName matches the struct types the check treats as options or partial patches.
// Case-sensitive on purpose: "StatusUpdate" or "Sample" carry data, they are not options.
var optionsTypeName = regexp.MustCompile(`(Opts|Options|Opt|Patch|Overrides|Override)$`)

// optionsParamName matches variadic parameter names that hold options whatever their type.
var optionsParamName = regexp.MustCompile(`^(opts|options|opt|patch|patches|overrides)$`)

var scalarIdents = map[string]bool{
	"bool": true, "int": true, "int8": true, "int16": true, "int32": true, "int64": true,
	"uint": true, "uint8": true, "uint16": true, "uint32": true, "uint64": true, "uintptr": true,
	"float32": true, "float64": true, "byte": true, "rune": true,
}

var scalarSelectors = map[string]bool{"time.Duration": true, "time.Month": true, "time.Weekday": true}

// pkgIndex holds the type declarations of one package directory.
type pkgIndex struct {
	structs map[string]map[string]ast.Expr // struct name -> field name -> type, promoted fields included
	named   map[string]ast.Expr            // non-struct named types and aliases -> underlying expression
}

func indexPackage(files []*ast.File) pkgIndex {
	index := pkgIndex{structs: map[string]map[string]ast.Expr{}, named: map[string]ast.Expr{}}
	embedded := map[string][]string{}
	for _, file := range files {
		for _, decl := range file.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.TYPE {
				continue
			}
			for _, spec := range gen.Specs {
				typeSpec := spec.(*ast.TypeSpec)
				st, ok := typeSpec.Type.(*ast.StructType)
				if !ok || typeSpec.Assign.IsValid() {
					index.named[typeSpec.Name.Name] = typeSpec.Type
					continue
				}
				fields := map[string]ast.Expr{}
				for _, field := range st.Fields.List {
					if len(field.Names) == 0 {
						if name := baseTypeName(field.Type); name != "" {
							embedded[typeSpec.Name.Name] = append(embedded[typeSpec.Name.Name], name)
						}
						continue
					}
					for _, name := range field.Names {
						fields[name.Name] = field.Type
					}
				}
				index.structs[typeSpec.Name.Name] = fields
			}
		}
	}
	// Promote fields of embedded structs declared in the same package (two levels is plenty).
	for round := 0; round < 2; round++ {
		for outer, inners := range embedded {
			for _, inner := range inners {
				for name, expr := range index.structs[inner] {
					if _, exists := index.structs[outer][name]; !exists {
						index.structs[outer][name] = expr
					}
				}
			}
		}
	}
	return index
}

// baseTypeName strips pointers, parentheses and type arguments: *Opts[T] -> Opts.
func baseTypeName(expr ast.Expr) string {
	for {
		switch e := expr.(type) {
		case *ast.StarExpr:
			expr = e.X
		case *ast.ParenExpr:
			expr = e.X
		case *ast.IndexExpr:
			expr = e.X
		case *ast.IndexListExpr:
			expr = e.X
		case *ast.Ident:
			return e.Name
		default:
			return ""
		}
	}
}

// structOf resolves a parameter type to a struct declared in the package, following aliases.
func (index pkgIndex) structOf(expr ast.Expr) string {
	name := baseTypeName(expr)
	for depth := 0; depth < 4 && name != ""; depth++ {
		if index.structs[name] != nil {
			return name
		}
		underlying, ok := index.named[name]
		if !ok {
			return ""
		}
		name = baseTypeName(underlying)
	}
	return ""
}

// optionsStruct is the options struct a parameter type names, or "".
func (index pkgIndex) optionsStruct(expr ast.Expr) string {
	name := index.structOf(expr)
	if name == "" {
		return ""
	}
	if optionsTypeName.MatchString(name) || optionsTypeName.MatchString(baseTypeName(expr)) {
		return name
	}
	return ""
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
