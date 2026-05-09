package handlers

// HandleHealthCheck returns the service health status.
func HandleHealthCheck() map[string]string {
	return map[string]string{"status": "ok"}
}
