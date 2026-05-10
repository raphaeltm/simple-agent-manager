package crossref

// Order represents a purchase order.
type Order struct {
	ID       string
	UserID   string
	Total    float64
	Discount float64
	Tax      float64
}

// Invoice is generated from an Order for billing.
type Invoice struct {
	OrderID  string
	Subtotal float64
	TaxAmt   float64
	Total    float64
}

// AuditEntry logs financial events.
type AuditEntry struct {
	OrderID string
	Action  string
	Amount  float64
}
