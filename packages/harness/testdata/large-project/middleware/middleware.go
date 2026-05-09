package middleware

import "example/auth"

// Stack is an ordered set of middleware handlers.
type Stack struct {
	auth *auth.Service
}

// NewStack creates a middleware stack with authentication.
func NewStack(authService *auth.Service) *Stack {
	return &Stack{auth: authService}
}
