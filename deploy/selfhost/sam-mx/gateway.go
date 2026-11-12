package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

// Headers of the Worker's inbound-email gateway route
// (apps/api/src/routes/self-host-gateway-inbound-email.ts). Keep the two in step.
const (
	headerGatewaySecret = "X-SAM-Gateway-Secret"
	headerMailFrom      = "X-SAM-Mail-From"
	headerRcptTo        = "X-SAM-Rcpt-To"
	headerMailAuth      = "X-SAM-Mail-Auth"
	headerMailAuthFrom  = "X-SAM-Mail-Auth-From-Domain"
)

// maxGatewayResponseBytes bounds the verdict body the receiver reads back.
const maxGatewayResponseBytes = 16 * 1024

// GatewayVerdict is the Worker's answer for one message.
type GatewayVerdict struct {
	Outcome string `json:"outcome"`
	Reason  string `json:"reason"`
}

// Delivery is one message for one recipient.
type Delivery struct {
	MailFrom string
	RcptTo   string
	Auth     *AuthVerdict
	Raw      []byte
}

// Gateway posts messages to the Worker on loopback.
type Gateway struct {
	cfg    *Config
	client *http.Client
}

func NewGateway(cfg *Config) *Gateway {
	return &Gateway{cfg: cfg, client: &http.Client{
		Timeout: cfg.GatewayTimeout,
		// Never follow a redirect off the loopback gateway with the secret attached.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// Deliver returns the Worker's verdict, or an error meaning "try again later" (451).
func (g *Gateway) Deliver(ctx context.Context, d Delivery) (*GatewayVerdict, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.cfg.GatewayURL.String(), bytes.NewReader(d.Raw))
	if err != nil {
		return nil, err
	}
	// celld builds request.url from X-Forwarded-Host (CELLD_TRUST_FORWARDED_HEADERS=1), as for
	// Caddy's forward_auth calls: name the API host so the request reaches the API router.
	req.Host = g.cfg.APIHost
	req.Header.Set("X-Forwarded-Host", g.cfg.APIHost)
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("Content-Type", "message/rfc822")
	req.Header.Set("Content-Length", strconv.Itoa(len(d.Raw)))
	req.ContentLength = int64(len(d.Raw))
	req.Header.Set(headerGatewaySecret, g.cfg.GatewaySecret)
	req.Header.Set(headerMailFrom, d.MailFrom)
	req.Header.Set(headerRcptTo, d.RcptTo)
	req.Header.Set(headerMailAuth, d.Auth.Result)
	req.Header.Set(headerMailAuthFrom, d.Auth.FromDomain)

	resp, err := g.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gateway request failed: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxGatewayResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("gateway response unreadable: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		// 401/404 mean this box is misconfigured (secret mismatch, inbound switch off in the
		// Worker); answer 451 so no mail is lost while the operator fixes it.
		slog.Error("sam-mx: gateway refused the request", "status", resp.StatusCode)
		return nil, fmt.Errorf("gateway answered HTTP %d", resp.StatusCode)
	}
	var verdict GatewayVerdict
	if err := json.Unmarshal(body, &verdict); err != nil || verdict.Outcome == "" {
		return nil, fmt.Errorf("gateway verdict unreadable")
	}
	return &verdict, nil
}

// smtpText makes a Worker reason safe for an SMTP reply line: printable ASCII, bounded.
func smtpText(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 0x20 && r < 0x7f {
			b.WriteRune(r)
		}
		if b.Len() >= 200 {
			break
		}
	}
	if b.Len() == 0 {
		return "Message refused"
	}
	return b.String()
}
