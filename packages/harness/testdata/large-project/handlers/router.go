package handlers

import (
	"example/db"
	"example/middleware"
)

// Router dispatches HTTP requests to handlers.
type Router struct {
	db *db.DB
	mw *middleware.Stack
}

// NewRouter creates a new router with database and middleware.
func NewRouter(database *db.DB, mw *middleware.Stack) *Router {
	return &Router{db: database, mw: mw}
}
