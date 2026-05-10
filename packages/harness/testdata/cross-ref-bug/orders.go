package crossref

// ProcessOrder calculates pricing and generates an invoice for the order.
func ProcessOrder(o Order) Invoice {
	// BUG: arguments to CalcTotal are in wrong order.
	// CalcTotal expects (basePrice, discountPct, taxRate)
	// but we pass (basePrice, taxRate, discountPct) — swapping discount and tax.
	subtotal, taxAmt, total := CalcTotal(o.Total, o.Tax, o.Discount)
	return FormatInvoice(o.ID, subtotal, taxAmt, total)
}

// CreateAuditEntry logs the order processing event.
func CreateAuditEntry(inv Invoice) AuditEntry {
	return AuditEntry{
		OrderID: inv.OrderID,
		Action:  "invoice_created",
		Amount:  inv.Total,
	}
}
