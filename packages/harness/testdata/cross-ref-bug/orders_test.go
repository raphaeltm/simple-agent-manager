package crossref

import (
	"math"
	"testing"
)

func TestProcessOrder(t *testing.T) {
	order := Order{
		ID:       "ORD-001",
		UserID:   "USR-001",
		Total:    100.0,
		Discount: 10.0, // 10% discount
		Tax:      0.08,  // 8% tax rate
	}

	inv := ProcessOrder(order)

	// Expected: base $100, 10% discount → subtotal $90, 8% tax → $7.20, total $97.20
	wantSubtotal := 90.0
	wantTax := 7.2
	wantTotal := 97.2

	if math.Abs(inv.Subtotal-wantSubtotal) > 0.01 {
		t.Errorf("Subtotal = %.2f, want %.2f", inv.Subtotal, wantSubtotal)
	}
	if math.Abs(inv.TaxAmt-wantTax) > 0.01 {
		t.Errorf("TaxAmt = %.2f, want %.2f", inv.TaxAmt, wantTax)
	}
	if math.Abs(inv.Total-wantTotal) > 0.01 {
		t.Errorf("Total = %.2f, want %.2f", inv.Total, wantTotal)
	}
}

func TestProcessOrderZeroDiscount(t *testing.T) {
	order := Order{
		ID:       "ORD-002",
		UserID:   "USR-002",
		Total:    50.0,
		Discount: 0,
		Tax:      0.10,
	}

	inv := ProcessOrder(order)

	wantSubtotal := 50.0
	wantTax := 5.0
	wantTotal := 55.0

	if math.Abs(inv.Subtotal-wantSubtotal) > 0.01 {
		t.Errorf("Subtotal = %.2f, want %.2f", inv.Subtotal, wantSubtotal)
	}
	if math.Abs(inv.TaxAmt-wantTax) > 0.01 {
		t.Errorf("TaxAmt = %.2f, want %.2f", inv.TaxAmt, wantTax)
	}
	if math.Abs(inv.Total-wantTotal) > 0.01 {
		t.Errorf("Total = %.2f, want %.2f", inv.Total, wantTotal)
	}
}
