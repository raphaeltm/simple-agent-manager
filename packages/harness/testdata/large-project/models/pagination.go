package models

// Page represents a paginated result set.
type Page struct {
	Items      []any
	Total      int
	PageSize   int
	PageNumber int
}

// HasNext returns true if there are more pages.
func (p *Page) HasNext() bool {
	return p.PageNumber*p.PageSize < p.Total
}
