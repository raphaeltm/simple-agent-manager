// sam-mx: the inbound SMTP receiver for a self-hosted SAM box (deploy/selfhost, profile mail-in).
//
// It accepts mail only for agent addresses on agents.<SAM_DOMAIN>, checks that the From domain is
// authenticated (aligned SPF or DKIM, i.e. DMARC pass), and hands each message, during the SMTP
// session, to the API Worker's loopback gateway route
// POST /api/self-host/gateway/inbound-email. The Worker runs the same handler Cloudflare Email
// Routing calls (handleInboundAgentEmail) and answers accepted/queued/duplicate or rejected; the
// receiver turns that into 250, 550 or (gateway unreachable) 451. It never relays, never sends
// a bounce, and never makes an outbound SMTP connection.
package main

import (
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/emersion/go-smtp"
)

func newServer(cfg *Config, backend smtp.Backend) (*smtp.Server, error) {
	s := smtp.NewServer(backend)
	s.Addr = cfg.ListenAddr
	s.Domain = cfg.Hostname
	s.MaxMessageBytes = cfg.MaxMessageBytes
	s.MaxRecipients = 1
	s.MaxLineLength = DefaultMaxLineLength
	s.ReadTimeout = cfg.ReadTimeout
	s.WriteTimeout = cfg.WriteTimeout
	// No AUTH: this is an MX, not a submission server.
	s.AllowInsecureAuth = false
	if cfg.TLSCertFile != "" {
		cert, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile)
		if err != nil {
			return nil, err
		}
		s.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	}
	return s, nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg, err := LoadConfigFromEnv()
	if err != nil {
		slog.Error("sam-mx: configuration error", "error", err.Error())
		os.Exit(64)
	}
	server, err := newServer(cfg, NewBackend(cfg, net.DefaultResolver, NewGateway(cfg)))
	if err != nil {
		slog.Error("sam-mx: TLS certificate could not be loaded", "error", err.Error())
		os.Exit(64)
	}
	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		slog.Error("sam-mx: listen failed", "addr", cfg.ListenAddr, "error", err.Error())
		os.Exit(1)
	}
	slog.Info("sam-mx: listening", "addr", cfg.ListenAddr, "domain", cfg.Domain,
		"starttls", server.TLSConfig != nil, "trustedNetworks", len(cfg.TrustedNetworks))

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		_ = server.Close()
	}()
	if err := server.Serve(newLimitedListener(listener, cfg)); err != nil && !errors.Is(err, smtp.ErrServerClosed) {
		slog.Error("sam-mx: server stopped", "error", err.Error())
		os.Exit(1)
	}
}
