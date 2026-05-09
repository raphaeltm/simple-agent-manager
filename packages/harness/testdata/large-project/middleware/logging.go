package middleware

import "fmt"

// LogRequest logs an incoming HTTP request.
func LogRequest(method, path string) {
	fmt.Printf("%s %s\n", method, path)
}
