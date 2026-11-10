package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"

	"github.com/workspace/vm-agent/internal/config"
)

// tunnelIngressKey marks a request that arrived on the Cloudflare Tunnel
// listener. It lives in the request context rather than a header: every header
// on a tunnel request is chosen by the remote caller, so a header marker could
// be omitted, and httputil.ReverseProxy would strip any header the caller names
// in Connection. A context value cannot be set or removed from the network.
type tunnelIngressKey struct{}

// classifyTunnelIngress wraps the agent's normal handler for the tunnel
// listener. Every request on that listener is external traffic relayed by the
// local cloudflared connector: its TCP peer is always loopback, so the peer
// address says nothing about the original caller. Classifying it as relayed
// before any route runs makes isRelayedRequest true for the whole request, which
// removes the bearerless loopback trust of the Docker Git credential helper.
// JWT, session, and callback-token checks are unchanged.
func classifyTunnelIngress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), tunnelIngressKey{}, true)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// isTunnelIngress reports whether the request arrived on the tunnel listener.
func isTunnelIngress(r *http.Request) bool {
	marked, _ := r.Context().Value(tunnelIngressKey{}).(bool)
	return marked
}

// buildHTTPServers creates the main listener and, when enabled, the tunnel
// listener around the same route mux.
//
// WriteTimeout is intentionally 0 on both because WebSocket connections are
// long-lived. Go's http.Server.WriteTimeout sets a deadline on the underlying
// net.Conn BEFORE the handler runs, which kills hijacked WebSocket connections
// after the timeout period.
func (s *Server) buildHTTPServers(mux *http.ServeMux) {
	cfg := s.config
	handler := corsMiddleware(mux, cfg.AllowedOrigins)
	s.httpServer = &http.Server{
		Addr:        fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		Handler:     handler,
		ReadTimeout: cfg.HTTPReadTimeout,
		IdleTimeout: cfg.HTTPIdleTimeout,
	}
	s.tunnelServer = newTunnelServer(cfg, handler)
}

// newTunnelServer builds the loopback-only tunnel listener, or nil when the
// tunnel is disabled (legacy direct-IP nodes and Instant containers). It serves
// the same routes as the main listener behind classifyTunnelIngress, with the
// same timeouts.
func newTunnelServer(cfg *config.Config, handler http.Handler) *http.Server {
	if cfg == nil || !cfg.Tunnel.Enabled {
		return nil
	}
	return &http.Server{
		Addr:        cfg.Tunnel.Addr(),
		Handler:     classifyTunnelIngress(handler),
		ReadTimeout: cfg.HTTPReadTimeout,
		IdleTimeout: cfg.HTTPIdleTimeout,
	}
}

// serveListeners binds every listener before serving any of them, so a bind
// failure (port in use, tunnel port collision) fails startup instead of
// leaving a node with only half its ingress. It returns the first serve error.
// After Stop, that is http.ErrServerClosed; any other error from one listener
// closes the other so the process exits and systemd restarts it whole.
func (s *Server) serveListeners() error {
	mainListener, err := net.Listen("tcp", s.httpServer.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", s.httpServer.Addr, err)
	}
	var tunnelListener net.Listener
	if s.tunnelServer != nil {
		tunnelListener, err = net.Listen("tcp", s.tunnelServer.Addr)
		if err != nil {
			_ = mainListener.Close()
			return fmt.Errorf("listen on tunnel address %s: %w", s.tunnelServer.Addr, err)
		}
	}

	errCh := make(chan error, 2)
	go func() {
		if s.config.TLSEnabled {
			slog.Info("Starting VM Agent with TLS", "addr", s.httpServer.Addr, "cert", s.config.TLSCertPath, "key", s.config.TLSKeyPath)
			errCh <- s.httpServer.ServeTLS(mainListener, s.config.TLSCertPath, s.config.TLSKeyPath)
			return
		}
		slog.Info("Starting VM Agent", "addr", s.httpServer.Addr)
		errCh <- s.httpServer.Serve(mainListener)
	}()
	if tunnelListener != nil {
		go func() {
			slog.Info("Starting VM Agent tunnel listener", "addr", s.tunnelServer.Addr)
			errCh <- s.tunnelServer.Serve(tunnelListener)
		}()
	}

	err = <-errCh
	if !errors.Is(err, http.ErrServerClosed) {
		slog.Error("VM Agent listener failed; closing remaining listeners", "error", err)
		_ = s.httpServer.Close()
		if s.tunnelServer != nil {
			_ = s.tunnelServer.Close()
		}
	}
	return err
}

// shutdownTunnelServer gracefully stops the tunnel listener, if any.
func (s *Server) shutdownTunnelServer(ctx context.Context) error {
	if s.tunnelServer == nil {
		return nil
	}
	return s.tunnelServer.Shutdown(ctx)
}

// isOwnListenerPort reports whether port is one this vm-agent listens on.
func (s *Server) isOwnListenerPort(port int) bool {
	if s.config == nil {
		return false
	}
	if s.config.Port > 0 && port == s.config.Port {
		return true
	}
	return s.config.Tunnel.Enabled && port == s.config.Tunnel.Port
}
