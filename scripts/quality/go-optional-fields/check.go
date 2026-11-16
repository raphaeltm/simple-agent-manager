package main

import (
	"fmt"
	"go/ast"
	"go/token"
	"strconv"
)

// scope is what one function body knows about options values.
type scope struct {
	vars   map[string]string // variable holding one options value -> struct type
	slices map[string]string // variadic options slice -> struct type
	fresh  map[string]bool   // locals built in this function, never loaded from existing state
}

func (s scope) clone() scope {
	next := scope{vars: map[string]string{}, slices: map[string]string{}, fresh: s.fresh}
	for k, v := range s.vars {
		next.vars[k] = v
	}
	for k, v := range s.slices {
		next.slices[k] = v
	}
	return next
}

// addParams records options-typed parameters (and receivers) of a function signature.
func (c *checker) addParams(s scope, fields *ast.FieldList) {
	if fields == nil {
		return
	}
	for _, field := range fields.List {
		if ellipsis, ok := field.Type.(*ast.Ellipsis); ok {
			name := c.index.structOf(ellipsis.Elt)
			if name == "" {
				continue
			}
			for _, param := range field.Names {
				if c.index.optionsStruct(ellipsis.Elt) != "" || optionsParamName.MatchString(param.Name) {
					s.slices[param.Name] = name
				}
			}
			continue
		}
		if name := c.index.optionsStruct(field.Type); name != "" {
			for _, param := range field.Names {
				s.vars[param.Name] = name
			}
		}
	}
}

// sliceElement resolves opts[i], *opts[i] or (opts[i]) to the options struct type.
func (s scope) sliceElement(expr ast.Expr) string {
	for {
		switch e := expr.(type) {
		case *ast.ParenExpr:
			expr = e.X
		case *ast.StarExpr:
			expr = e.X
		case *ast.IndexExpr:
			if slice, ok := e.X.(*ast.Ident); ok {
				return s.slices[slice.Name]
			}
			return ""
		default:
			return ""
		}
	}
}

// bindAliases records locals bound from an options slice: opt := opts[0], var opt = *opts[0],
// for _, opt := range opts.
func (s scope) bindAliases(body ast.Node) {
	ast.Inspect(body, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.AssignStmt:
			if len(n.Lhs) != len(n.Rhs) {
				return true
			}
			for i, rhs := range n.Rhs {
				if typ := s.sliceElement(rhs); typ != "" {
					if lhs, ok := n.Lhs[i].(*ast.Ident); ok {
						s.vars[lhs.Name] = typ
					}
				}
			}
		case *ast.ValueSpec:
			for i, value := range n.Values {
				if typ := s.sliceElement(value); typ != "" && i < len(n.Names) {
					s.vars[n.Names[i].Name] = typ
				}
			}
		case *ast.RangeStmt:
			if slice, ok := n.X.(*ast.Ident); ok && s.slices[slice.Name] != "" {
				if value, ok := n.Value.(*ast.Ident); ok {
					s.vars[value.Name] = s.slices[slice.Name]
				}
			}
		}
		return true
	})
}

// optField reports whether expr is a field of an options value: opt.F, opts[i].F, (*o).F.
func (s scope) optField(expr ast.Expr) (root, typ, field string, ok bool) {
	sel, isSel := expr.(*ast.SelectorExpr)
	if !isSel {
		return "", "", "", false
	}
	x := sel.X
	for {
		paren, isParen := x.(*ast.ParenExpr)
		if !isParen {
			break
		}
		x = paren.X
	}
	if star, isStar := x.(*ast.StarExpr); isStar {
		x = star.X
	}
	switch e := x.(type) {
	case *ast.Ident:
		if typ := s.vars[e.Name]; typ != "" {
			return e.Name, typ, sel.Sel.Name, true
		}
	case *ast.IndexExpr:
		if typ := s.sliceElement(e); typ != "" {
			return exprString(e.X) + "[...]", typ, sel.Sel.Name, true
		}
	}
	return "", "", "", false
}

type guard struct {
	cond     ast.Expr
	positive bool // the guarded code runs when cond is true (if-body, case), false after an early exit
}

func (c *checker) checkFunc(s scope, body *ast.BlockStmt) {
	if body == nil || (len(s.vars) == 0 && len(s.slices) == 0) {
		return
	}
	c.stats.OptionFuncs++
	c.walk(s, body, nil)
}

func (c *checker) walkCondFuncLits(s scope, expr ast.Expr, guards []guard) {
	if expr == nil {
		return
	}
	ast.Inspect(expr, func(node ast.Node) bool {
		if lit, ok := node.(*ast.FuncLit); ok {
			c.walkFuncLit(s, lit, guards)
			return false
		}
		return true
	})
}

func (c *checker) walkFuncLit(s scope, lit *ast.FuncLit, guards []guard) {
	inner := s.clone()
	c.addParams(inner, lit.Type.Params)
	inner.bindAliases(lit.Body)
	c.walk(inner, lit.Body, guards)
}

// caseCondition is the condition a case clause runs under: `tag == v1 || tag == v2`, or for a
// tagless switch `e1 || e2`.
func caseCondition(tag ast.Expr, values []ast.Expr) ast.Expr {
	var cond ast.Expr
	for _, value := range values {
		term := value
		if tag != nil {
			term = &ast.BinaryExpr{X: tag, Op: token.EQL, Y: value}
		}
		if cond == nil {
			cond = term
		} else {
			cond = &ast.BinaryExpr{X: cond, Op: token.LOR, Y: term}
		}
	}
	return cond
}

func with(guards []guard, extra ...guard) []guard {
	return append(append([]guard{}, guards...), extra...)
}

// walk visits every statement once, carrying the conditions under which it runs.
func (c *checker) walk(s scope, node ast.Node, guards []guard) {
	switch n := node.(type) {
	case nil:
		return
	case *ast.BlockStmt:
		c.walkList(s, n.List, guards)
	case *ast.IfStmt:
		c.walk(s, n.Init, guards)
		c.walkCondFuncLits(s, n.Cond, guards)
		c.walk(s, n.Body, with(guards, guard{n.Cond, true}))
		// An else branch runs when the condition is false: absence included. Not a guard.
		c.walk(s, n.Else, guards)
	case *ast.SwitchStmt:
		c.walk(s, n.Init, guards)
		for _, stmt := range n.Body.List {
			clause := stmt.(*ast.CaseClause)
			inner := guards
			switch {
			case len(clause.List) == 0: // default: runs when nothing matched, absence included
			case n.Tag != nil:
				inner = with(guards, guard{caseCondition(n.Tag, clause.List), true})
			default:
				inner = with(guards, guard{caseCondition(nil, clause.List), true})
			}
			c.walkList(s, clause.Body, inner)
		}
	case *ast.TypeSwitchStmt:
		c.walk(s, n.Init, guards)
		for _, stmt := range n.Body.List {
			c.walkList(s, stmt.(*ast.CaseClause).Body, guards)
		}
	case *ast.SelectStmt:
		for _, stmt := range n.Body.List {
			c.walkList(s, stmt.(*ast.CommClause).Body, guards)
		}
	case *ast.ForStmt:
		c.walk(s, n.Init, guards)
		c.walk(s, n.Body, guards)
	case *ast.RangeStmt:
		c.walk(s, n.Body, guards)
	case *ast.LabeledStmt:
		c.walk(s, n.Stmt, guards)
	case *ast.AssignStmt:
		c.checkAssign(s, n, guards)
		for _, rhs := range n.Rhs {
			c.walkCondFuncLits(s, rhs, guards)
		}
	default:
		c.walkCondFuncLits(s, toExpr(n), guards)
		if stmt, ok := n.(*ast.ExprStmt); ok {
			c.walkCondFuncLits(s, stmt.X, guards)
		}
	}
}

// toExpr returns the expressions of statements that can hold function literals.
func toExpr(node ast.Node) ast.Expr {
	switch n := node.(type) {
	case *ast.DeferStmt:
		return n.Call
	case *ast.GoStmt:
		return n.Call
	case *ast.ReturnStmt:
		if len(n.Results) > 0 {
			return n.Results[0]
		}
	}
	return nil
}

// walkList walks statements in order; an `if cond { return }` adds `!cond` for the rest.
func (c *checker) walkList(s scope, list []ast.Stmt, guards []guard) {
	for _, stmt := range list {
		c.walk(s, stmt, guards)
		if ifStmt, ok := stmt.(*ast.IfStmt); ok && ifStmt.Else == nil && exits(ifStmt.Body) {
			guards = with(guards, guard{ifStmt.Cond, false})
		}
	}
}

func exits(body *ast.BlockStmt) bool {
	if len(body.List) == 0 {
		return false
	}
	switch last := body.List[len(body.List)-1].(type) {
	case *ast.ReturnStmt:
		return true
	case *ast.BranchStmt:
		return last.Tok == token.CONTINUE || last.Tok == token.BREAK || last.Tok == token.GOTO
	case *ast.ExprStmt:
		call, ok := last.X.(*ast.CallExpr)
		if !ok {
			return false
		}
		ident, ok := call.Fun.(*ast.Ident)
		return ok && ident.Name == "panic"
	}
	return false
}

// optFieldRefs lists scalar options fields read anywhere in expr: !o.F, T(o.F)*k, o.F+1.
func (c *checker) optFieldRefs(s scope, expr ast.Expr) [][3]string {
	var refs [][3]string
	ast.Inspect(expr, func(node ast.Node) bool {
		if _, isLit := node.(*ast.FuncLit); isLit {
			return false
		}
		sel, ok := node.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		root, typ, field, ok := s.optField(sel)
		if !ok {
			return true
		}
		if fieldType, known := c.index.structs[typ][field]; known {
			if kind := c.index.scalarKind(fieldType, 0); kind != "" {
				refs = append(refs, [3]string{root, field, kind})
			}
		}
		return false
	})
	return refs
}

func (c *checker) checkAssign(s scope, n *ast.AssignStmt, guards []guard) {
	if n.Tok != token.ASSIGN || len(n.Lhs) != len(n.Rhs) {
		return
	}
	for i, rhs := range n.Rhs {
		target := n.Lhs[i]
		if _, isIdent := target.(*ast.Ident); isIdent {
			continue // a local variable, not stored state
		}
		refs := c.copiedRefs(s, target, rhs)
		if root := rootIdent(target); root != nil && s.fresh[root.Name] {
			c.stats.FreshSkipped += len(refs)
			continue
		}
		if len(refs) == 0 {
			c.checkConstantUnderTruthiness(s, n, target, rhs, guards)
			continue
		}
		for _, ref := range refs {
			c.stats.ScalarCopies++
			c.judge(s, n, target, ref, guards)
		}
	}
}

// copiedRefs are the options fields an assignment copies onto `target`. A struct literal
// counts only when it replaces existing state wholesale (`*r = R{...}`): stored into a map
// or slice it is usually a create.
func (c *checker) copiedRefs(s scope, target, rhs ast.Expr) [][3]string {
	inner := rhs
	if unary, ok := inner.(*ast.UnaryExpr); ok && unary.Op == token.AND {
		inner = unary.X
	}
	if lit, ok := inner.(*ast.CompositeLit); ok {
		if _, replaces := target.(*ast.StarExpr); !replaces {
			return nil
		}
		var refs [][3]string
		for _, element := range lit.Elts {
			if kv, ok := element.(*ast.KeyValueExpr); ok {
				refs = append(refs, c.optFieldRefs(s, kv.Value)...)
			}
		}
		return refs
	}
	return c.optFieldRefs(s, rhs)
}

func (c *checker) judge(s scope, n *ast.AssignStmt, target ast.Expr, ref [3]string, guards []guard) {
	root, field, kind := ref[0], ref[1], ref[2]
	verdict := classifyGuards(s, guards, root, field, target)
	if verdict == guardPresence {
		return
	}
	pos := c.fset.Position(n.Pos())
	if c.optedOut(pos) {
		c.stats.OptedOut++
		return
	}
	lhs := exprString(target)
	if verdict == guardTruthiness {
		c.report(pos, fmt.Sprintf(
			"%s is set from %s.%s (%s) only when that field is truthy, so it can never be set back to %s. Make the field a pointer (nil = not supplied). See %s",
			lhs, root, field, kind, zeroOf(kind), ruleFile))
		return
	}
	c.report(pos, fmt.Sprintf(
		"%s is set from %s.%s (%s) with no \"not supplied\" check, so a caller that omits it overwrites the stored value with %s. Make the field a pointer (nil = not supplied) and assign only when it is set. See %s",
		lhs, root, field, kind, zeroOf(kind), ruleFile))
}

// checkConstantUnderTruthiness reports `if opt.F { r.F = true }`: the field still cannot be
// cleared, although nothing is copied from it.
func (c *checker) checkConstantUnderTruthiness(s scope, n *ast.AssignStmt, target, rhs ast.Expr, guards []guard) {
	sel, ok := target.(*ast.SelectorExpr)
	if !ok {
		return
	}
	if _, isLit := rhs.(*ast.BasicLit); !isLit {
		if ident, isIdent := rhs.(*ast.Ident); !isIdent || (ident.Name != "true" && ident.Name != "false") {
			return
		}
	}
	for root, typ := range s.vars {
		fieldType, known := c.index.structs[typ][sel.Sel.Name]
		if !known || c.index.scalarKind(fieldType, 0) == "" {
			continue
		}
		if classifyGuards(s, guards, root, sel.Sel.Name, target) == guardTruthiness {
			c.judge(s, n, target, [3]string{root, sel.Sel.Name, c.index.scalarKind(fieldType, 0)}, guards)
		}
	}
}

type guardVerdict int

const (
	guardNone guardVerdict = iota
	guardPresence
	guardTruthiness
)

// classifyGuards decides whether the enclosing conditions check that root.field was supplied.
// A truthiness test anywhere (`if o.F`, `o.F > 0`, `!o.F` before an early return) wins: the
// field can then never be set to its zero value. A comparison with the target itself
// (`if o.F != r.F`) checks nothing. Any other mention, including a presence flag
// (`o.HasF`, `o.FSet`), counts as a check.
func classifyGuards(s scope, guards []guard, root, field string, target ast.Expr) guardVerdict {
	verdict := guardNone
	for _, g := range guards {
		for _, conjunct := range conjuncts(g.cond, g.positive) {
			switch mentionKind(s, conjunct.expr, conjunct.positive, root, field, target) {
			case mentionTruthiness:
				return guardTruthiness
			case mentionPresence:
				verdict = guardPresence
			}
		}
	}
	return verdict
}

type conjunct struct {
	expr     ast.Expr
	positive bool
}

// conjuncts splits `a && b` when the guarded code runs on true, and `a || b` (each negated)
// when it runs after an early exit on true.
func conjuncts(expr ast.Expr, positive bool) []conjunct {
	if paren, ok := expr.(*ast.ParenExpr); ok {
		return conjuncts(paren.X, positive)
	}
	if binary, ok := expr.(*ast.BinaryExpr); ok {
		if (positive && binary.Op == token.LAND) || (!positive && binary.Op == token.LOR) {
			return append(conjuncts(binary.X, positive), conjuncts(binary.Y, positive)...)
		}
	}
	if unary, ok := expr.(*ast.UnaryExpr); ok && unary.Op == token.NOT {
		return conjuncts(unary.X, !positive)
	}
	return []conjunct{{expr, positive}}
}

type mention int

const (
	mentionNone mention = iota
	mentionPresence
	mentionTruthiness
	mentionTarget
)

func mentionKind(s scope, expr ast.Expr, positive bool, root, field string, target ast.Expr) mention {
	isField := func(e ast.Expr) bool {
		r, _, f, ok := s.optField(e)
		return ok && r == root && f == field
	}
	if isField(expr) {
		if positive {
			return mentionTruthiness
		}
		return mentionPresence
	}
	if binary, ok := expr.(*ast.BinaryExpr); ok {
		left, right := binary.X, binary.Y
		if isField(right) {
			left, right = right, left
		}
		if isField(left) {
			switch {
			case exprString(right) == exprString(target):
				return mentionTarget
			case isZero(right) && ((positive && (binary.Op == token.NEQ || binary.Op == token.GTR)) ||
				(!positive && (binary.Op == token.EQL || binary.Op == token.LEQ))):
				return mentionTruthiness
			case isTrue(right) && ((positive && binary.Op == token.EQL) || (!positive && binary.Op == token.NEQ)):
				return mentionTruthiness
			}
		}
	}
	found := mentionNone
	ast.Inspect(expr, func(node ast.Node) bool {
		sel, ok := node.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		r, _, f, ok := s.optField(sel)
		if ok && r == root && (f == field || f == "Has"+field || f == field+"Set" || f == "Set"+field) {
			found = mentionPresence
		}
		return found == mentionNone
	})
	return found
}

func isZero(expr ast.Expr) bool {
	lit, ok := expr.(*ast.BasicLit)
	if !ok || (lit.Kind != token.INT && lit.Kind != token.FLOAT) {
		return false
	}
	value, err := strconv.ParseFloat(lit.Value, 64)
	return err == nil && value == 0
}

func isTrue(expr ast.Expr) bool {
	ident, ok := expr.(*ast.Ident)
	return ok && ident.Name == "true"
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
		return exprString(e.X) + "[" + exprString(e.Index) + "]"
	case *ast.ParenExpr:
		return "(" + exprString(e.X) + ")"
	case *ast.CallExpr:
		return exprString(e.Fun) + "(...)"
	case *ast.BasicLit:
		return e.Value
	}
	return "<expr>"
}
