package server

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"

	"github.com/workspace/vm-agent/internal/deploy"
)

// appIngressPathPrefix is the route the control plane's tunnel delivers app traffic to
// (apps/api/src/selfhost/reverse-tunnel/app-route.ts, APP_INGRESS_PATH_PREFIX).
const appIngressPathPrefix = "/deployment/app-ingress/"

// appIngressAuthorizationHeader carries SAM's node-management token, so the app's own
// Authorization header reaches the app untouched (deploy/selfhost/caddy/Caddyfile, *.apps site).
const appIngressAuthorizationHeader = "X-SAM-Node-Authorization"

// withAppIngress sends app ingress straight to its handler, ahead of the agent's own middleware:
// CORS answers every OPTIONS itself and the token-redirect guard refuses non-canonical paths,
// but an app's preflights, paths and query strings belong to the app. It also keeps the
// ServeMux from redirecting a non-canonical app path to an agent URL.
func (s *Server) withAppIngress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, appIngressPathPrefix) {
			s.handleDeploymentAppIngress(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

var appIngressHostnamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)

// handleDeploymentAppIngress carries one app request (HTTP or WebSocket) that arrived through the
// control plane's tunnel to this node's loopback-only Caddy. It serves only on a deployment node
// in tunnel app ingress (DEPLOY_APP_INGRESS=tunnel); every other node answers 404.
//
// The control plane already decided the request may reach this node. The agent still checks, on
// its own state: the management token is for this node, the routed node id is this node, and the
// hostname is a site of an active environment's applied Caddy snippet. Node Caddy then routes the
// exact hostname to that route's loopback port, so no other port on the node is reachable.
func (s *Server) handleDeploymentAppIngress(w http.ResponseWriter, r *http.Request) {
	port := 0
	if s.config != nil {
		port = s.config.AppIngressLoopbackPort()
	}
	if port == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	// Authenticate a copy carrying SAM's token, leaving the app's Authorization on the request.
	authRequest := r.Clone(r.Context())
	authRequest.Header.Set("Authorization", r.Header.Get(appIngressAuthorizationHeader))
	if !s.requireNodeManagementAuth(w, authRequest, "") {
		return
	}
	if s.routedNodeID(r) != s.config.NodeID {
		writeError(w, http.StatusForbidden, "node route mismatch")
		return
	}

	host, path, rawPath := appIngressTarget(r)
	if host != strings.ToLower(host) || !appIngressHostnamePattern.MatchString(host) {
		writeError(w, http.StatusBadRequest, "invalid app hostname")
		return
	}
	served, err := s.appIngressServesHostname(host)
	if err != nil {
		slog.Error("app ingress: cannot read applied routes", "hostname", host, "error", err)
		writeError(w, http.StatusServiceUnavailable, "app routes are unavailable")
		return
	}
	if !served {
		slog.Warn("app ingress: hostname is not an applied route on this node", "hostname", host, "action", "rejected")
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	s.serveAppIngress(w, r, host, port, path, rawPath)
}

// appIngressServesHostname reports whether any environment active on this node applied host.
func (s *Server) appIngressServesHostname(host string) (bool, error) {
	s.deployMu.Lock()
	engines := make([]*deploy.Engine, 0, len(s.deployEngines))
	for _, engine := range s.deployEngines {
		engines = append(engines, engine)
	}
	s.deployMu.Unlock()
	for _, engine := range engines {
		served, err := engine.ServesHostname(host)
		if err != nil {
			return false, err
		}
		if served {
			return true, nil
		}
	}
	return false, nil
}

// appIngressTarget splits /deployment/app-ingress/<host>[/<path>] into the hostname and the
// app's own path, keeping the path's original encoding (rawPath is empty when it has none).
func appIngressTarget(r *http.Request) (host, path, rawPath string) {
	rest := strings.TrimPrefix(r.URL.EscapedPath(), appIngressPathPrefix)
	host, escapedPath, found := strings.Cut(rest, "/")
	escapedPath = "/" + escapedPath
	if !found || escapedPath == "/" {
		return host, "/", ""
	}
	decoded, err := url.PathUnescape(escapedPath)
	if err != nil {
		return "", "", ""
	}
	if decoded == escapedPath {
		return host, decoded, ""
	}
	return host, decoded, escapedPath
}

func (s *Server) serveAppIngress(w http.ResponseWriter, r *http.Request, host string, port int, path, rawPath string) {
	target := &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", port)}
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(req *http.Request) {
		director(req)
		req.URL.Path = path
		req.URL.RawPath = rawPath
		req.Host = host
		// SAM's routing and credential headers never reach the app.
		for name := range req.Header {
			if strings.HasPrefix(strings.ToLower(name), "x-sam-") {
				req.Header.Del(name)
			}
		}
		markProxiedRequest(req.Header)
		req.Header.Set("X-Forwarded-Host", host)
		req.Header.Set("X-Forwarded-Proto", "https")
	}
	proxy.ErrorHandler = func(rw http.ResponseWriter, _ *http.Request, proxyErr error) {
		slog.Error("app ingress: upstream error", "hostname", host, "error", proxyErr)
		writeError(rw, http.StatusBadGateway, "app is not responding")
	}
	proxy.ServeHTTP(w, r)
}
