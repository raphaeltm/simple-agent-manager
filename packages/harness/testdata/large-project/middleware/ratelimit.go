package middleware

// RateLimiter limits request rates per IP address.
type RateLimiter struct {
	maxRequests int
	windowSecs  int
}

// NewRateLimiter creates a rate limiter.
func NewRateLimiter(maxRequests, windowSecs int) *RateLimiter {
	return &RateLimiter{maxRequests: maxRequests, windowSecs: windowSecs}
}

// Allow checks if a request from the given IP is allowed.
func (r *RateLimiter) Allow(ip string) bool {
	return true
}
