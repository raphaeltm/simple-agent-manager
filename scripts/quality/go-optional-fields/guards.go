package main

import (
	"go/ast"
	"go/token"
	"strconv"
)

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
