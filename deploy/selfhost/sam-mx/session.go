package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"strings"

	"github.com/emersion/go-smtp"
)

// Backend creates one Session per SMTP connection.
type Backend struct {
	cfg      *Config
	resolver Resolver
	gateway  *Gateway
}

func NewBackend(cfg *Config, resolver Resolver, gateway *Gateway) *Backend {
	return &Backend{cfg: cfg, resolver: resolver, gateway: gateway}
}

func (b *Backend) NewSession(c *smtp.Conn) (smtp.Session, error) {
	ip := net.IPv4zero
	if host, _, err := net.SplitHostPort(c.Conn().RemoteAddr().String()); err == nil {
		if parsed := net.ParseIP(host); parsed != nil {
			ip = parsed
		}
	}
	return &Session{backend: b, conn: c, ip: ip}, nil
}

// Session handles one connection. Every refusal is an SMTP reply in the session: the receiver
// never generates a bounce (no backscatter), and never relays.
type Session struct {
	backend  *Backend
	conn     *smtp.Conn
	ip       net.IP
	mailFrom string
	hasMail  bool
	rcptTo   string
	messages int
}

func smtpErr(code int, enhanced smtp.EnhancedCode, msg string) *smtp.SMTPError {
	return &smtp.SMTPError{Code: code, EnhancedCode: enhanced, Message: msg}
}

func (s *Session) Reset() {
	s.mailFrom, s.hasMail, s.rcptTo = "", false, ""
}

func (s *Session) Logout() error { return nil }

func (s *Session) Mail(from string, _ *smtp.MailOptions) error {
	if s.messages >= s.backend.cfg.MessagesPerConn {
		return smtpErr(421, smtp.EnhancedCode{4, 7, 0}, "Too many messages on this connection, reconnect")
	}
	s.mailFrom, s.hasMail = strings.TrimSpace(from), true
	return nil
}

func (s *Session) Rcpt(to string, _ *smtp.RcptOptions) error {
	if !s.hasMail {
		return smtpErr(503, smtp.EnhancedCode{5, 5, 1}, "MAIL first")
	}
	if s.rcptTo != "" {
		// One recipient per transaction, so the DATA reply is that recipient's own verdict.
		// RFC 5321 4.5.3.1.10: the client sends the rest in a later transaction.
		return smtpErr(452, smtp.EnhancedCode{4, 5, 3}, "One recipient per message, send the others separately")
	}
	if !s.backend.cfg.IsAgentRecipient(to) {
		return smtpErr(550, smtp.EnhancedCode{5, 1, 1}, "Unknown address")
	}
	s.rcptTo = strings.ToLower(strings.TrimSpace(to))
	return nil
}

func (s *Session) Data(r io.Reader) error {
	raw, err := io.ReadAll(r)
	if err != nil {
		if errors.Is(err, smtp.ErrDataTooLarge) {
			return smtp.ErrDataTooLarge
		}
		if errors.Is(err, smtp.ErrTooLongLine) {
			// RFC 5322 caps a line at 998 characters; a longer one will never be accepted.
			return smtpErr(552, smtp.EnhancedCode{5, 6, 0}, "Line too long")
		}
		slog.Warn("sam-mx: DATA read failed", "error", err.Error())
		return smtpErr(451, smtp.EnhancedCode{4, 3, 0}, "Message could not be read, try again later")
	}
	if s.rcptTo == "" {
		return smtpErr(503, smtp.EnhancedCode{5, 5, 1}, "RCPT first")
	}
	if hasBareLineFeed(raw) {
		// RFC 5321 2.3.8 requires CRLF. A bare LF lets two parsers (this one and the Worker's)
		// split headers differently, so refuse it, as Postfix does by default (smtpd_forbid_bare_newline).
		return smtpErr(550, smtp.EnhancedCode{5, 6, 0}, "Bare LF line endings are not accepted")
	}
	s.messages++
	cfg := s.backend.cfg
	logCtx := []any{"client", s.ip.String(), "recipientDomain", cfg.Domain, "bytes", len(raw)}

	dnsCtx, cancel := context.WithTimeout(context.Background(), cfg.DNSTimeout)
	defer cancel()
	verdict, err := Authenticate(dnsCtx, s.backend.resolver, s.ip, s.conn.Hostname(), s.mailFrom, raw, cfg.IsTrusted(s.ip))
	if err != nil {
		var authErr *AuthError
		if errors.As(err, &authErr) && authErr.Temporary {
			slog.Warn("sam-mx: sender authentication deferred", append(logCtx, "reason", authErr.Reason)...)
			return smtpErr(451, smtp.EnhancedCode{4, 7, 0}, smtpText(authErr.Reason))
		}
		slog.Info("sam-mx: sender authentication refused", append(logCtx, "reason", err.Error())...)
		return smtpErr(550, smtp.EnhancedCode{5, 7, 1}, smtpText(err.Error()))
	}
	logCtx = append(logCtx, "auth", verdict.Result, "spf", verdict.SPF, "dkim", verdict.DKIM)

	result, err := s.backend.gateway.Deliver(context.Background(), Delivery{
		MailFrom: s.mailFrom,
		RcptTo:   s.rcptTo,
		Auth:     verdict,
		Raw:      raw,
	})
	if err != nil {
		slog.Error("sam-mx: gateway unavailable", append(logCtx, "error", err.Error())...)
		return smtpErr(451, smtp.EnhancedCode{4, 3, 0}, "Temporary failure, try again later")
	}
	switch result.Outcome {
	case "accepted", "queued", "duplicate", "loopback":
		slog.Info("sam-mx: delivered", append(logCtx, "outcome", result.Outcome)...)
		return nil
	case "rejected":
		slog.Info("sam-mx: refused by SAM", append(logCtx, "reason", smtpText(result.Reason))...)
		return smtpErr(550, smtp.EnhancedCode{5, 7, 1}, smtpText(result.Reason))
	default:
		slog.Error("sam-mx: unknown gateway outcome", append(logCtx, "outcome", smtpText(result.Outcome))...)
		return smtpErr(451, smtp.EnhancedCode{4, 3, 0}, "Temporary failure, try again later")
	}
}

// hasBareLineFeed reports an LF not preceded by CR, or a CR not followed by LF.
func hasBareLineFeed(raw []byte) bool {
	for i, b := range raw {
		if b == '\n' && (i == 0 || raw[i-1] != '\r') {
			return true
		}
		if b == '\r' && (i+1 >= len(raw) || raw[i+1] != '\n') {
			return true
		}
	}
	return false
}
