package server

import (
	"net/http"
	"path"
	"strings"
)

// refuseTokenRedirects runs before ServeMux: Go canonicalizes paths with a 307
// that copies RawQuery into Location, before the route can consume its JWT.
// Reject only token-bearing noncanonical paths. Do not wrap ResponseWriter:
// normal preview redirects and WebSocket hijacking must keep working.
func refuseTokenRedirects(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Has("token") {
			escaped := r.URL.EscapedPath()
			cleaned := path.Clean("/" + strings.TrimPrefix(escaped, "/"))
			if strings.HasSuffix(escaped, "/") && cleaned != "/" {
				cleaned += "/"
			}
			if escaped != cleaned {
				writeError(w, http.StatusBadRequest, "noncanonical authenticated path")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
