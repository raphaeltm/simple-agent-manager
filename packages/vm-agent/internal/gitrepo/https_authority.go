package gitrepo

import (
	"net"
	"strconv"
	"strings"
)

// HTTPSAuthoritiesEqual compares HTTPS origins using the control plane's WHATWG
// port representation. Empty authorities or invalid ports never match each other.
func HTTPSAuthoritiesEqual(left, right string) bool {
	left = canonicalHTTPSAuthority(left)
	right = canonicalHTTPSAuthority(right)
	return left != "" && right != "" && strings.EqualFold(left, right)
}

func canonicalHTTPSAuthority(authority string) string {
	authority = strings.TrimSpace(authority)
	host, port, err := net.SplitHostPort(authority)
	if err != nil {
		return authority
	}
	if port == "" {
		return strings.TrimSuffix(authority, ":")
	}
	number, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		return ""
	}
	if number == 443 {
		return strings.TrimSuffix(authority, ":"+port)
	}
	return net.JoinHostPort(host, strconv.FormatUint(number, 10))
}
