package server

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

var localForwardHopHeaders = map[string]struct{}{
	"connection":          {},
	"keep-alive":          {},
	"proxy-authenticate":  {},
	"proxy-authorization": {},
	"te":                  {},
	"trailer":             {},
	"transfer-encoding":   {},
	"upgrade":             {},
}

func (s *Server) handleWorkspaceLocalForward(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	portValue := r.PathValue("port")
	port, err := strconv.Atoi(portValue)
	if workspaceID == "" || err != nil || port < 1 || port > 65535 {
		writeError(w, http.StatusBadRequest, "invalid workspace local forward target")
		return
	}
	if r.Header.Get("Upgrade") != "" {
		writeError(w, http.StatusNotImplemented, "WebSocket upgrades are not supported by CLI local forwarding yet")
		return
	}
	token := r.Header.Get("X-SAM-VM-Forward-Token")
	if token == "" {
		writeError(w, http.StatusUnauthorized, "missing local forward token")
		return
	}
	claims, err := s.jwtValidator.ValidateLocalForwardToken(token, workspaceID, port)
	if err != nil {
		slog.Warn("Local forward auth failed", "workspaceId", workspaceID, "port", port, "error", err)
		writeError(w, http.StatusUnauthorized, "invalid local forward token")
		return
	}

	targetHost, err := s.resolveWorkspaceBridgeIP(workspaceID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}

	forwardPath := r.PathValue("path")
	if forwardPath == "" {
		forwardPath = "/"
	} else if forwardPath[0] != '/' {
		forwardPath = "/" + forwardPath
	}

	targetURL := fmt.Sprintf("http://%s:%d", targetHost, port)
	slog.Info("Local forward proxying",
		"workspaceId", workspaceID,
		"port", port,
		"target", targetURL,
		"localAuthority", claims.LocalAuthority)
	s.serveLocalForwardProxy(w, r, targetURL, forwardPath, claims.LocalAuthority)
}

func (s *Server) resolveWorkspaceBridgeIP(workspaceID string) (string, error) {
	targetHost := "127.0.0.1"
	discovery := s.containerDiscovery
	s.portScannerMu.RLock()
	if wsDisc, ok := s.portDiscoveries[workspaceID]; ok {
		discovery = wsDisc
	}
	s.portScannerMu.RUnlock()

	if discovery == nil {
		return targetHost, nil
	}
	bridgeIP, err := discovery.GetBridgeIP()
	if err != nil {
		return "", fmt.Errorf("container bridge IP not available yet: %w", err)
	}
	return bridgeIP, nil
}

func (s *Server) serveLocalForwardProxy(w http.ResponseWriter, r *http.Request, targetURLStr string, forwardPath string, localAuthority string) {
	targetURL, err := url.Parse(targetURLStr)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to build local forward target")
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = forwardPath
		req.URL.RawPath = ""
		req.Host = localAuthority
		stripLocalForwardRequestHeaders(req.Header)
		req.Header.Set("Host", localAuthority)
		req.Header.Set("X-Forwarded-Host", localAuthority)
		req.Header.Set("X-Forwarded-Proto", "http")
	}
	proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
		slog.Error("Local forward upstream error", "target", targetURLStr, "error", proxyErr)
		writeError(rw, http.StatusBadGateway, fmt.Sprintf("local forward proxy error: %v", proxyErr))
	}
	proxy.ServeHTTP(w, r)
}

func stripLocalForwardRequestHeaders(headers http.Header) {
	for name := range headers {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "x-sam-") ||
			strings.HasPrefix(lower, "x-forwarded-") ||
			lower == "forwarded" ||
			hasLocalForwardHopHeader(lower) {
			headers.Del(name)
		}
	}
}

func hasLocalForwardHopHeader(name string) bool {
	_, ok := localForwardHopHeaders[name]
	return ok
}
