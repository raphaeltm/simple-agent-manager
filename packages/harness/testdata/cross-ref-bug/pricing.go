package crossref

// CalcTotal computes the final price after applying discount and tax.
// Parameters: basePrice, discountPct (0-100), taxRate (0-1).
func CalcTotal(basePrice, discountPct, taxRate float64) (subtotal, taxAmt, total float64) {
	subtotal = basePrice * (1 - discountPct/100)
	taxAmt = subtotal * taxRate
	total = subtotal + taxAmt
	return
}

// FormatInvoice creates an Invoice from pricing components.
func FormatInvoice(orderID string, subtotal, taxAmt, total float64) Invoice {
	return Invoice{
		OrderID:  orderID,
		Subtotal: subtotal,
		TaxAmt:   taxAmt,
		Total:    total,
	}
}
