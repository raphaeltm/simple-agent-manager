package server

import (
	"net/http"
	"strings"
)

// stripPortProxyCredentials runs after agent authentication, on the cloned
// upstream request. Application cookies and application Authorization survive;
// SAM credentials must not become readable by a forwarded development server.
func (s *Server) stripPortProxyCredentials(r *http.Request) {
	cookieName := s.config.CookieName
	if cookieName == "" {
		cookieName = "vm_session"
	}
	cookieName = previewCookieName(cookieName)
	cookies := r.Cookies()
	r.Header.Del("Cookie")
	for _, cookie := range cookies {
		name := previewCookieName(cookie.Name)
		if name == "sam_port_access" || name == cookieName || strings.HasPrefix(name, cookieName+"_") ||
			name == "vm_session" || strings.HasPrefix(name, "vm_session_") || strings.HasPrefix(name, "better-auth.") {
			continue
		}
		r.AddCookie(cookie)
	}
	// A cookie-authenticated request can carry application Bearer auth. Remove
	// only a Bearer token that is itself a valid SAM workspace credential, including
	// when the session cookie meant requireWorkspaceRequestAuth did not consume it.
	if scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " "); ok && strings.EqualFold(scheme, "Bearer") && s.jwtValidator != nil {
		token = strings.TrimSpace(token)
		if _, err := s.jwtValidator.Validate(token); err == nil {
			r.Header.Del("Authorization")
		}
	}
}

func previewCookieName(name string) string {
	return strings.TrimPrefix(strings.TrimPrefix(name, "__Secure-"), "__Host-")
}
