package server

import (
	"net/http"
	"regexp"
	"strings"
)

var workspaceCookieSuffixPattern = regexp.MustCompile(`(?i)^[0-9a-hjkmnp-tv-z]{26}$`)

var betterAuthSessionCookies = map[string]struct{}{
	"better-auth.session_token":          {},
	"__secure-better-auth.session_token": {},
	"__host-better-auth.session_token":   {},
}

func isSAMReservedCookieName(name, vmSessionCookieName string) bool {
	normalized := strings.ToLower(strings.TrimSpace(name))
	vmSessionCookieName = strings.ToLower(strings.TrimSpace(vmSessionCookieName))
	if strings.HasPrefix(normalized, "sam_") {
		return true
	}
	for _, baseName := range []string{"vm_session", vmSessionCookieName} {
		if baseName == "" {
			continue
		}
		if normalized == baseName {
			return true
		}
		if suffix, found := strings.CutPrefix(normalized, baseName+"_"); found && workspaceCookieSuffixPattern.MatchString(suffix) {
			return true
		}
	}
	_, reserved := betterAuthSessionCookies[normalized]
	return reserved
}

func stripSAMReservedRequestCookies(headers http.Header, vmSessionCookieName string) {
	value := headers.Get("Cookie")
	if value == "" {
		return
	}
	parts := strings.Split(value, ";")
	applicationCookies := make([]string, 0, len(parts))
	for _, part := range parts {
		cookie := strings.TrimSpace(part)
		name, _, _ := strings.Cut(cookie, "=")
		if cookie != "" && !isSAMReservedCookieName(name, vmSessionCookieName) {
			applicationCookies = append(applicationCookies, cookie)
		}
	}
	if len(applicationCookies) == 0 {
		headers.Del("Cookie")
		return
	}
	headers.Set("Cookie", strings.Join(applicationCookies, "; "))
}

func makePreviewCookieHostOnly(value string) string {
	parts := strings.Split(value, ";")
	hostOnly := parts[:0]
	for index, part := range parts {
		if index > 0 && strings.HasPrefix(strings.ToLower(strings.TrimSpace(part)), "domain=") {
			continue
		}
		hostOnly = append(hostOnly, part)
	}
	return strings.Join(hostOnly, ";")
}

func sanitizeClearSiteData(headers http.Header) {
	values := headers.Values("Clear-Site-Data")
	if len(values) == 0 {
		return
	}
	headers.Del("Clear-Site-Data")
	for _, value := range values {
		safeDirectives := make([]string, 0)
		for _, directive := range strings.Split(value, ",") {
			trimmed := strings.TrimSpace(directive)
			normalized := strings.ToLower(strings.Trim(trimmed, `"`))
			if normalized != "cookies" && normalized != "*" {
				safeDirectives = append(safeDirectives, trimmed)
			}
		}
		if len(safeDirectives) > 0 {
			headers.Add("Clear-Site-Data", strings.Join(safeDirectives, ", "))
		}
	}
}

func sanitizePreviewResponseCookies(response *http.Response, vmSessionCookieName string) error {
	values := response.Header.Values("Set-Cookie")
	response.Header.Del("Set-Cookie")
	for _, value := range values {
		name, _, _ := strings.Cut(value, "=")
		if !isSAMReservedCookieName(name, vmSessionCookieName) {
			response.Header.Add("Set-Cookie", makePreviewCookieHostOnly(value))
		}
	}
	sanitizeClearSiteData(response.Header)
	return nil
}
