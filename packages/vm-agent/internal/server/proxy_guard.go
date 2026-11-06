package server

import (
	"fmt"
	"net"
	"net/http"
	"strings"
)

// proxiedRequestHeader marks a request that a SAM proxy relayed: the vm-agent's
// workspace port proxy and local forward, and the API Worker's container forward.
// For a relayed request the TCP peer is the proxy, not the original client, so
// the peer address must not be used as an authorization signal. The check is
// presence-only: a client that sets the header itself can only lose access.
const proxiedRequestHeader = "X-SAM-Proxied-Request"

func markProxiedRequest(h http.Header) {
	h.Set(proxiedRequestHeader, "1")
}

// isRelayedRequest reports whether a SAM proxy relayed the request. Besides the
// explicit marker it treats X-Forwarded-Host as a relay signal, because every
// SAM relay path sets it (the API Worker on container forwards, the port proxy
// passes it through, local forward sets it) and in-workspace helpers that call
// the vm-agent directly never do.
func isRelayedRequest(r *http.Request) bool {
	return r.Header.Get(proxiedRequestHeader) != "" || r.Header.Get("X-Forwarded-Host") != ""
}

// isOwnListenerTarget reports whether a proxy target would reach this vm-agent's
// own HTTP listener. That happens whenever the proxy falls back to loopback
// (standalone/cf-container mode, or a host without container discovery) and the
// requested port is the vm-agent's listen port. Workspace ports must never be
// able to reach the agent's own routes this way, whatever their auth model.
func (s *Server) isOwnListenerTarget(targetHost string, port int) bool {
	if s.config == nil || s.config.Port <= 0 || port != s.config.Port {
		return false
	}
	host := strings.TrimSpace(targetHost)
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsUnspecified())
}

func reservedAgentPortMessage(port int) string {
	return fmt.Sprintf("port %d is reserved for the SAM workspace agent and cannot be proxied", port)
}
