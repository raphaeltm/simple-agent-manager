package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/emersion/go-msgauth/dkim"
	"github.com/emersion/go-smtp"
)

const (
	testSecret  = "0123456789abcdef0123456789abcdef-test"
	testDomain  = "box.example"
	agentRcpt   = "agent+k3j2h7m9q2xw4n8p@agents.box.example"
	allowedFrom = "alice@sender.example"
)

// fakeDNS answers TXT lookups from a map; everything else is "not found".
type fakeDNS struct {
	txt map[string][]string
	// tempFail names that answer with a temporary DNS error.
	tempFail map[string]bool
}

func notFound(name string) error {
	return &net.DNSError{Err: "no such host", Name: name, IsNotFound: true}
}

func (f *fakeDNS) LookupTXT(_ context.Context, name string) ([]string, error) {
	name = strings.TrimSuffix(strings.ToLower(name), ".")
	if f.tempFail[name] {
		return nil, &net.DNSError{Err: "server misbehaving", Name: name, IsTemporary: true}
	}
	if v, ok := f.txt[name]; ok {
		return v, nil
	}
	return nil, notFound(name)
}
func (f *fakeDNS) LookupMX(_ context.Context, name string) ([]*net.MX, error) {
	return nil, notFound(name)
}
func (f *fakeDNS) LookupIPAddr(_ context.Context, name string) ([]net.IPAddr, error) {
	return nil, notFound(name)
}
func (f *fakeDNS) LookupAddr(_ context.Context, addr string) ([]string, error) {
	return nil, notFound(addr)
}

// gatewayCall is what the fake Worker gateway received.
type gatewayCall struct {
	header http.Header
	host   string
	body   []byte
}

type fakeGateway struct {
	mu      sync.Mutex
	calls   []gatewayCall
	status  int
	verdict string
}

func (g *fakeGateway) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	g.mu.Lock()
	g.calls = append(g.calls, gatewayCall{header: r.Header.Clone(), host: r.Host, body: body})
	status, verdict := g.status, g.verdict
	g.mu.Unlock()
	if r.Header.Get(headerGatewaySecret) != testSecret {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if status != 0 {
		w.WriteHeader(status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, verdict)
}

func (g *fakeGateway) count() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.calls)
}

type harness struct {
	t       *testing.T
	addr    string
	dns     *fakeDNS
	gateway *fakeGateway
	cfg     *Config
	key     ed25519.PrivateKey
}

// newHarness runs the real receiver (config, listener limits, go-smtp server, session, gateway
// client) on a loopback port against a fake gateway HTTP server.
func newHarness(t *testing.T, mutate func(map[string]string)) *harness {
	t.Helper()
	gw := &fakeGateway{verdict: `{"outcome":"accepted"}`}
	srv := httptest.NewServer(http.HandlerFunc(gw.handler))
	t.Cleanup(srv.Close)

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dns := &fakeDNS{
		txt: map[string][]string{
			"sel._domainkey.sender.example": {"v=DKIM1; k=ed25519; p=" + base64.StdEncoding.EncodeToString(pub)},
			"sel._domainkey.evil.example":   {"v=DKIM1; k=ed25519; p=" + base64.StdEncoding.EncodeToString(pub)},
			"_dmarc.sender.example":         {"v=DMARC1; p=reject"},
			// 127.0.0.1 is the test client; spf.example authorises it.
			"spf.example": {"v=spf1 ip4:127.0.0.1 -all"},
		},
		tempFail: map[string]bool{},
	}
	env := map[string]string{
		"SAM_DOMAIN":                    testDomain,
		"REVERSE_TUNNEL_GATEWAY_SECRET": testSecret,
		"SAM_MX_LISTEN":                 "127.0.0.1:0",
		"SAM_MX_GATEWAY_URL":            srv.URL + "/api/self-host/gateway/inbound-email",
		"SAM_MX_MAX_MESSAGE_BYTES":      "4096",
	}
	if mutate != nil {
		mutate(env)
	}
	cfg, err := LoadConfig(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	server, err := newServer(cfg, NewBackend(cfg, dns, NewGateway(cfg)))
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Serve(newLimitedListener(ln, cfg)) }()
	t.Cleanup(func() { _ = server.Close() })
	return &harness{t: t, addr: ln.Addr().String(), dns: dns, gateway: gw, cfg: cfg, key: priv}
}

func message(from, subject string) []byte {
	return []byte(strings.Join([]string{
		"From: Alice <" + from + ">",
		"To: " + agentRcpt,
		"Subject: " + subject,
		"Message-ID: <m-" + subject + "@sender.example>",
		"Date: Thu, 12 Nov 2026 01:00:00 +0000",
		"",
		"Please fix the login bug.",
		"",
	}, "\r\n"))
}

func (h *harness) sign(domain string, raw []byte) []byte {
	h.t.Helper()
	var out bytes.Buffer
	err := dkim.Sign(&out, bytes.NewReader(raw), &dkim.SignOptions{
		Domain: domain, Selector: "sel", Signer: h.key,
		HeaderKeys: []string{"From", "To", "Subject", "Message-ID", "Date"},
	})
	if err != nil {
		h.t.Fatal(err)
	}
	return out.Bytes()
}

// send runs one real SMTP transaction and returns the error from the step that failed.
func (h *harness) send(mailFrom string, rcpts []string, raw []byte) error {
	h.t.Helper()
	c, err := smtp.Dial(h.addr)
	if err != nil {
		return err
	}
	defer c.Close()
	if err := c.Hello("client.sender.example"); err != nil {
		return err
	}
	if err := c.Mail(mailFrom, nil); err != nil {
		return err
	}
	for _, r := range rcpts {
		if err := c.Rcpt(r, nil); err != nil {
			return err
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(raw); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

func smtpCode(t *testing.T, err error) int {
	t.Helper()
	var se *smtp.SMTPError
	if !errors.As(err, &se) {
		t.Fatalf("expected an SMTP error reply, got %v", err)
	}
	return se.Code
}

func TestAllowedSenderWithAlignedDKIMIsDeliveredToTheGateway(t *testing.T) {
	h := newHarness(t, nil)
	raw := h.sign("sender.example", message(allowedFrom, "dkim"))
	if err := h.send("bounce@other.example", []string{agentRcpt}, raw); err != nil {
		t.Fatalf("delivery failed: %v", err)
	}
	if h.gateway.count() != 1 {
		t.Fatalf("gateway calls = %d, want 1", h.gateway.count())
	}
	call := h.gateway.calls[0]
	for name, want := range map[string]string{
		headerGatewaySecret: testSecret,
		headerMailFrom:      "bounce@other.example",
		headerRcptTo:        agentRcpt,
		headerMailAuth:      "pass",
		headerMailAuthFrom:  "sender.example",
		"X-Forwarded-Host":  "api." + testDomain,
		"Content-Type":      "message/rfc822",
	} {
		if got := call.header.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if call.host != "api."+testDomain {
		t.Errorf("Host = %q", call.host)
	}
	if !bytes.Contains(call.body, []byte("Please fix the login bug.")) || !bytes.Contains(call.body, []byte("DKIM-Signature")) {
		t.Errorf("body was not the signed message: %q", call.body)
	}
}

func TestAlignedSPFPassIsEnough(t *testing.T) {
	h := newHarness(t, nil)
	// No DKIM; SPF for spf.example authorises 127.0.0.1 and From is the same domain.
	if err := h.send("bob@spf.example", []string{agentRcpt}, message("bob@spf.example", "spf")); err != nil {
		t.Fatalf("delivery failed: %v", err)
	}
	if got := h.gateway.calls[0].header.Get(headerMailAuthFrom); got != "spf.example" {
		t.Fatalf("auth domain = %q", got)
	}
}

func TestSenderRefusedBySAMGets550DuringTheSession(t *testing.T) {
	h := newHarness(t, nil)
	h.gateway.verdict = `{"outcome":"rejected","reason":"Sender not allowed"}`
	raw := h.sign("sender.example", message("mallory@sender.example", "notallowed"))
	err := h.send("mallory@sender.example", []string{agentRcpt}, raw)
	if smtpCode(t, err) != 550 || !strings.Contains(err.Error(), "Sender not allowed") {
		t.Fatalf("want 550 Sender not allowed, got %v", err)
	}
	if h.gateway.count() != 1 {
		t.Fatalf("the gateway must decide; calls = %d", h.gateway.count())
	}
}

func TestForgedFromFailingDMARCIsRefusedWithoutCallingSAM(t *testing.T) {
	h := newHarness(t, nil)
	// Unsigned, and the envelope domain has no SPF: From sender.example is unauthenticated.
	err := h.send("x@nospf.example", []string{agentRcpt}, message(allowedFrom, "forged"))
	if smtpCode(t, err) != 550 || !strings.Contains(err.Error(), "authentication failed") {
		t.Fatalf("want 550 authentication failed, got %v", err)
	}
	if h.gateway.count() != 0 {
		t.Fatal("an unauthenticated message must not reach the Worker")
	}
}

func TestDKIMPassForAnotherDomainIsNotAligned(t *testing.T) {
	h := newHarness(t, nil)
	// Signed by evil.example (valid signature) but claiming From sender.example.
	raw := h.sign("evil.example", message(allowedFrom, "unaligned"))
	err := h.send("x@nospf.example", []string{agentRcpt}, raw)
	if smtpCode(t, err) != 550 {
		t.Fatalf("want 550, got %v", err)
	}
	// Control: SPF pass for a different domain is not aligned either.
	err = h.send("bob@spf.example", []string{agentRcpt}, message(allowedFrom, "spf-unaligned"))
	if smtpCode(t, err) != 550 {
		t.Fatalf("want 550 for unaligned SPF, got %v", err)
	}
	if h.gateway.count() != 0 {
		t.Fatal("unaligned mail must not reach the Worker")
	}
}

func TestOversizedMessageIsRefused(t *testing.T) {
	h := newHarness(t, nil)
	big := append(message(allowedFrom, "big"), bytes.Repeat([]byte(strings.Repeat("x", 78)+"\r\n"), 120)...)
	err := h.send(allowedFrom, []string{agentRcpt}, h.sign("sender.example", big))
	if smtpCode(t, err) != 552 {
		t.Fatalf("want 552, got %v", err)
	}
	if h.gateway.count() != 0 {
		t.Fatal("an oversized message must not reach the Worker")
	}
	// A single over-long line is refused permanently too, not deferred.
	long := append(message(allowedFrom, "long"), bytes.Repeat([]byte("y"), 3000)...)
	if code := smtpCode(t, h.send(allowedFrom, []string{agentRcpt}, long)); code != 552 {
		t.Fatalf("over-long line: want 552, got %d", code)
	}
}

func TestUnknownRecipientsAreRefusedAtRCPT(t *testing.T) {
	h := newHarness(t, nil)
	for _, rcpt := range []string{
		"agent+k3j2h7m9q2xw4n8p@other.example", // not this install: never a relay
		"postmaster@agents.box.example",
		"agent+short@agents.box.example",
		"agent+k3j2h7m9q2xw4n8i@agents.box.example", // 'i' is not in the key alphabet
	} {
		err := h.send(allowedFrom, []string{rcpt}, message(allowedFrom, "rcpt"))
		if smtpCode(t, err) != 550 {
			t.Errorf("%s: want 550, got %v", rcpt, err)
		}
	}
	if h.gateway.count() != 0 {
		t.Fatal("no message should reach the Worker")
	}
}

func TestOneRecipientPerTransaction(t *testing.T) {
	h := newHarness(t, nil)
	err := h.send(allowedFrom, []string{agentRcpt, "agent+loopback@agents.box.example"}, nil)
	if smtpCode(t, err) != 452 {
		t.Fatalf("want 452 for the second recipient, got %v", err)
	}
}

func TestGatewayFailureIsTemporary(t *testing.T) {
	for _, status := range []int{http.StatusInternalServerError, http.StatusNotFound} {
		h := newHarness(t, nil)
		h.gateway.status = status
		err := h.send(allowedFrom, []string{agentRcpt}, h.sign("sender.example", message(allowedFrom, "gw")))
		if smtpCode(t, err) != 451 {
			t.Fatalf("HTTP %d: want 451, got %v", status, err)
		}
	}
	// Wrong secret: the Worker answers 401 and the receiver defers rather than accepting.
	h := newHarness(t, func(env map[string]string) {
		env["REVERSE_TUNNEL_GATEWAY_SECRET"] = strings.Repeat("w", 40)
	})
	err := h.send(allowedFrom, []string{agentRcpt}, h.sign("sender.example", message(allowedFrom, "secret")))
	if smtpCode(t, err) != 451 {
		t.Fatalf("wrong secret: want 451, got %v", err)
	}
}

func TestDNSTempFailureIsTemporary(t *testing.T) {
	h := newHarness(t, nil)
	h.dns.tempFail["_dmarc.sender.example"] = true
	err := h.send(allowedFrom, []string{agentRcpt}, h.sign("sender.example", message(allowedFrom, "temp")))
	if smtpCode(t, err) != 451 {
		t.Fatalf("want 451, got %v", err)
	}
}

func TestTrustedLoopbackSkipsAuthenticationAndSaysSo(t *testing.T) {
	h := newHarness(t, func(env map[string]string) { env["SAM_MX_TRUSTED_NETWORKS"] = "127.0.0.1/32" })
	if err := h.send(allowedFrom, []string{agentRcpt}, message(allowedFrom, "trusted")); err != nil {
		t.Fatalf("delivery failed: %v", err)
	}
	call := h.gateway.calls[0]
	if call.header.Get(headerMailAuth) != "trusted" || call.header.Get(headerMailAuthFrom) != "sender.example" {
		t.Fatalf("auth headers = %q/%q", call.header.Get(headerMailAuth), call.header.Get(headerMailAuthFrom))
	}
}

func TestTrustedNetworksMustBeLoopback(t *testing.T) {
	for _, bad := range []string{"0.0.0.0/0", "10.0.0.0/8", "127.0.0.0/4"} {
		if _, err := ParseTrustedNetworks(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

func TestPerAddressConnectionRateLimit(t *testing.T) {
	h := newHarness(t, func(env map[string]string) { env["SAM_MX_CONNECTIONS_PER_IP_PER_MINUTE"] = "2" })
	for i := 0; i < 2; i++ {
		if err := h.send(allowedFrom, []string{agentRcpt}, h.sign("sender.example", message(allowedFrom, fmt.Sprint(i)))); err != nil {
			t.Fatalf("connection %d: %v", i, err)
		}
	}
	err := h.send(allowedFrom, []string{agentRcpt}, nil)
	if smtpCode(t, err) != 421 {
		t.Fatalf("want 421 on the third connection, got %v", err)
	}
}

func TestConfigRefusesUnsafeGateway(t *testing.T) {
	base := map[string]string{"SAM_DOMAIN": testDomain, "REVERSE_TUNNEL_GATEWAY_SECRET": testSecret}
	for name, mutate := range map[string]func(map[string]string){
		"short secret":   func(e map[string]string) { e["REVERSE_TUNNEL_GATEWAY_SECRET"] = "short" },
		"non-loopback":   func(e map[string]string) { e["SAM_MX_GATEWAY_URL"] = "http://10.0.0.5:8080/x" },
		"https off-box":  func(e map[string]string) { e["SAM_MX_GATEWAY_URL"] = "https://api.box.example/x" },
		"missing domain": func(e map[string]string) { delete(e, "SAM_DOMAIN") },
	} {
		env := map[string]string{}
		for k, v := range base {
			env[k] = v
		}
		mutate(env)
		if _, err := LoadConfig(func(k string) string { return env[k] }); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	cfg, err := LoadConfig(func(k string) string { return base[k] })
	if err != nil {
		t.Fatal(err)
	}
	want, _ := url.Parse("http://127.0.0.1:8080/api/self-host/gateway/inbound-email")
	if cfg.GatewayURL.String() != want.String() || cfg.Domain != "agents."+testDomain || cfg.ListenAddr != ":25" {
		t.Fatalf("defaults: %+v", cfg)
	}

}

func TestBareLineFeedsAreRefused(t *testing.T) {
	h := newHarness(t, func(env map[string]string) { env["SAM_MX_TRUSTED_NETWORKS"] = "127.0.0.1/32" })
	// A second From hidden behind a bare LF: two header parsers could disagree on it.
	raw := []byte("From: alice@sender.example\nFrom: mallory@evil.example\r\nTo: " + agentRcpt +
		"\r\nSubject: x\r\n\r\nbody\r\n")
	if code := smtpCode(t, h.send(allowedFrom, []string{agentRcpt}, raw)); code != 550 {
		t.Fatalf("want 550, got %d", code)
	}
	bareCR := []byte("From: alice@sender.example\r\nTo: " + agentRcpt + "\r\nSubject: x\rY\r\n\r\nbody\r\n")
	if code := smtpCode(t, h.send(allowedFrom, []string{agentRcpt}, bareCR)); code != 550 {
		t.Fatalf("bare CR: want 550, got %d", code)
	}
	if h.gateway.count() != 0 {
		t.Fatal("must not reach the Worker")
	}
}
