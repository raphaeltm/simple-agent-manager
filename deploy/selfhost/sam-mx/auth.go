package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"strings"
	"time"

	"blitiri.com.ar/go/spf"
	"github.com/emersion/go-msgauth/dkim"
	"github.com/emersion/go-msgauth/dmarc"
	"golang.org/x/net/publicsuffix"
)

// Resolver is the DNS the checks use. net.DefaultResolver in production; a fake in tests.
type Resolver = spf.DNSResolver

// AuthVerdict is the receiver's sender-authentication result for one message.
type AuthVerdict struct {
	// "pass": SPF or DKIM passed and is aligned with the From domain (DMARC pass).
	// "trusted": the client is in SAM_MX_TRUSTED_NETWORKS (box loopback); no checks ran.
	Result string
	// The message's single From address, lower case, and its domain. The Worker requires the
	// From it parses to be exactly this address, so the two parsers cannot disagree about who
	// sent it.
	FromAddress string
	FromDomain  string
	SPF         string
	DKIM        string
}

// AuthError is a refusal: Temporary means 451 (retry later), otherwise 550.
type AuthError struct {
	Temporary bool
	Reason    string
}

func (e *AuthError) Error() string { return e.Reason }

func permFail(reason string) error { return &AuthError{Reason: reason} }
func tempFail(reason string) error { return &AuthError{Temporary: true, Reason: reason} }

// Headers that must appear at most once: every one of them feeds a decision (sender identity,
// threading, dedupe, loop guards), and a second copy is where two parsers disagree.
var singleHeaders = map[string]bool{
	"from": true, "sender": true, "reply-to": true, "subject": true, "message-id": true,
	"in-reply-to": true, "references": true, "auto-submitted": true, "precedence": true,
	"list-id": true,
	// The DKIM replay checks read these (dkimBindsRecipient, dkimFresh). DKIM signs one instance
	// per name from the bottom, so an unsigned copy prepended above a signed one could otherwise
	// name the agent address or carry a fresh date.
	"to": true, "cc": true, "date": true,
}

// checkHeaderBlock refuses header blocks two parsers could read differently: a field name that
// is not a plain token directly followed by ':' ("From :" is a From header to some parsers and
// not to others), a leading continuation line, or a repeated decision header.
func checkHeaderBlock(raw []byte) error {
	seen := map[string]bool{}
	first := true
	for len(raw) > 0 {
		end := bytes.Index(raw, []byte("\r\n"))
		if end < 0 {
			end = len(raw)
		}
		line := raw[:end]
		if end+2 <= len(raw) {
			raw = raw[end+2:]
		} else {
			raw = nil
		}
		if len(line) == 0 {
			return nil // end of the header block
		}
		if line[0] == ' ' || line[0] == '\t' {
			if first {
				return permFail("the message header starts with a continuation line")
			}
			continue
		}
		first = false
		colon := bytes.IndexByte(line, ':')
		if colon <= 0 {
			return permFail("malformed header line")
		}
		for _, c := range line[:colon] {
			if c < 33 || c > 126 {
				return permFail("malformed header field name")
			}
		}
		name := strings.ToLower(string(line[:colon]))
		if singleHeaders[name] {
			if seen[name] {
				return permFail(fmt.Sprintf("duplicate %s header", name))
			}
			seen[name] = true
		}
	}
	return nil
}

// ParseFrom checks the header block and returns the single From address (lower case) and its
// domain.
func ParseFrom(raw []byte) (address, domain string, err error) {
	if err := checkHeaderBlock(raw); err != nil {
		return "", "", err
	}
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return "", "", permFail("the message header could not be read")
	}
	fromHeaders := msg.Header["From"]
	if len(fromHeaders) != 1 {
		return "", "", permFail("exactly one From header is required")
	}
	addrs, err := mail.ParseAddressList(fromHeaders[0])
	if err != nil || len(addrs) != 1 {
		return "", "", permFail("exactly one From address is required")
	}
	address = strings.ToLower(addrs[0].Address)
	if !plainMailbox(address) {
		return "", "", permFail("the From address is not a plain mailbox")
	}
	domain, err = domainOf(address)
	return address, domain, err
}

func domainOf(addr string) (string, error) {
	at := strings.LastIndex(addr, "@")
	if at <= 0 || at == len(addr)-1 {
		return "", permFail("the From address has no domain")
	}
	return strings.TrimSuffix(strings.ToLower(addr[at+1:]), "."), nil
}

func orgDomain(domain string) string {
	org, err := publicsuffix.EffectiveTLDPlusOne(domain)
	if err != nil {
		return domain
	}
	return org
}

func aligned(authDomain, fromDomain string, mode dmarc.AlignmentMode) bool {
	authDomain = strings.TrimSuffix(strings.ToLower(authDomain), ".")
	if authDomain == "" {
		return false
	}
	if mode == dmarc.AlignmentStrict {
		return authDomain == fromDomain
	}
	return orgDomain(authDomain) == orgDomain(fromDomain)
}

// lookupDMARC returns the record for the From domain, falling back to its organizational domain
// (RFC 7489 6.6.3). Only relaxed alignment consults it, for a domain that asks for strict
// alignment. A domain with no record is (nil, nil). Any other DNS failure is an error, so a
// record that could not be read never silently loosens alignment.
func lookupDMARC(ctx context.Context, r Resolver, fromDomain string) (*dmarc.Record, error) {
	for _, domain := range []string{fromDomain, orgDomain(fromDomain)} {
		txts, err := r.LookupTXT(ctx, "_dmarc."+domain)
		if err != nil {
			var dnsErr *net.DNSError
			if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
				if domain == orgDomain(fromDomain) {
					break
				}
				continue
			}
			return nil, err
		}
		for _, txt := range txts {
			if !strings.HasPrefix(txt, "v=") {
				continue
			}
			// An unparseable record is treated as no record (RFC 7489 6.6.3).
			if record, err := dmarc.Parse(txt); err == nil {
				return record, nil
			}
		}
		if domain == orgDomain(fromDomain) {
			break
		}
	}
	return nil, nil
}

// AuthPolicy is the per-message input to Authenticate besides the message itself.
type AuthPolicy struct {
	// RelaxedAlignment: see Config.RelaxedAlignment. False means strict alignment.
	RelaxedAlignment bool
	// DKIMMaxAge bounds the Date of a message authenticated by DKIM alone.
	DKIMMaxAge time.Duration
	// Recipient is the envelope recipient (the agent address).
	Recipient string
	Now       func() time.Time
}

// Headers a DKIM signature must cover for DKIM alone to authenticate the message. From is
// required by the library already. To and Date bind the signature to its original recipient and
// time, so a signed message from an allowed sender cannot be replayed to an agent address
// (dkimBindsRecipient, dkimFresh); Subject and Message-ID carry the prompt and the dedupe key.
var dkimRequiredHeaders = []string{"from", "to", "subject", "message-id", "date"}

// Authenticate decides whether the message's From domain is authenticated: SPF (for the
// envelope sender) or DKIM pass, aligned with the From domain. This is DMARC's pass condition,
// required whatever policy the domain publishes: the trigger's sender allowlist compares From
// addresses, so an unaligned pass would let anyone with their own SPF record send as an allowed
// sender. Cloudflare Email Routing, which the Worker relied on before, enforces published DMARC
// policies; this is stricter on purpose.
func Authenticate(ctx context.Context, r Resolver, ip net.IP, helo, envelopeFrom string, raw []byte, trusted bool, policy AuthPolicy) (*AuthVerdict, error) {
	fromAddress, fromDomain, err := ParseFrom(raw)
	if err != nil {
		return nil, err
	}
	if trusted {
		return &AuthVerdict{Result: "trusted", FromAddress: fromAddress, FromDomain: fromDomain, SPF: "none", DKIM: "none"}, nil
	}

	verdict := &AuthVerdict{FromAddress: fromAddress, FromDomain: fromDomain, SPF: "none", DKIM: "none"}
	temporary := false

	// SPF for the envelope sender; for a null sender, the HELO identity (RFC 7208 2.3).
	spfSender := envelopeFrom
	if spfSender == "" {
		spfSender = "postmaster@" + helo
	}
	spfDomain, _ := domainOf(spfSender)
	spfResult, spfErr := spf.CheckHostWithSender(ip, helo, spfSender, spf.WithResolver(r), spf.WithContext(ctx))
	verdict.SPF = string(spfResult)
	if spfResult == spf.TempError || (spfErr != nil && spfResult == "") {
		temporary = true
	}

	var dkimPasses []*dkim.Verification
	verifications, dkimErr := dkim.VerifyWithOptions(bytes.NewReader(raw), &dkim.VerifyOptions{
		LookupTXT:        func(name string) ([]string, error) { return r.LookupTXT(ctx, name) },
		MaxVerifications: 5,
	})
	if dkimErr != nil && !errors.Is(dkimErr, dkim.ErrTooManySignatures) {
		verdict.DKIM = "permerror"
	}
	for _, v := range verifications {
		switch {
		case v.Err == nil && signsHeaders(v.HeaderKeys, dkimRequiredHeaders...):
			dkimPasses = append(dkimPasses, v)
			verdict.DKIM = "pass"
		case dkim.IsTempFail(v.Err):
			temporary = true
			if verdict.DKIM != "pass" {
				verdict.DKIM = "temperror"
			}
		default:
			if verdict.DKIM == "none" {
				verdict.DKIM = "fail"
			}
		}
	}

	// Strict unless the operator opted into relaxed alignment; even then a domain whose DMARC
	// record asks for strict alignment gets it. A record never loosens alignment.
	var spfMode, dkimMode dmarc.AlignmentMode = dmarc.AlignmentStrict, dmarc.AlignmentStrict
	if policy.RelaxedAlignment {
		record, dmarcErr := lookupDMARC(ctx, r, fromDomain)
		if dmarcErr != nil {
			return nil, tempFail("the sender's DMARC policy could not be read; try again later")
		}
		spfMode, dkimMode = dmarc.AlignmentRelaxed, dmarc.AlignmentRelaxed
		if record != nil && record.SPFAlignment == dmarc.AlignmentStrict {
			spfMode = dmarc.AlignmentStrict
		}
		if record != nil && record.DKIMAlignment == dmarc.AlignmentStrict {
			dkimMode = dmarc.AlignmentStrict
		}
	}

	if spfResult == spf.Pass && aligned(spfDomain, fromDomain, spfMode) {
		verdict.Result = "pass"
		return verdict, nil
	}
	var dkimRefusal string
	for _, v := range dkimPasses {
		if !aligned(v.Domain, fromDomain, dkimMode) {
			continue
		}
		if reason := dkimReplayRefusal(raw, v, policy); reason != "" {
			dkimRefusal = reason
			continue
		}
		verdict.Result = "pass"
		return verdict, nil
	}
	if dkimRefusal != "" {
		return nil, permFail(dkimRefusal)
	}
	if temporary {
		return nil, tempFail("sender authentication could not be completed; try again later")
	}
	return nil, permFail(fmt.Sprintf("sender authentication failed for %s (no aligned SPF or DKIM pass)", fromDomain))
}

func signsHeaders(keys []string, required ...string) bool {
	signed := map[string]bool{}
	for _, k := range keys {
		signed[strings.ToLower(strings.TrimSpace(k))] = true
	}
	for _, r := range required {
		if !signed[r] {
			return false
		}
	}
	return true
}

// plainMailbox mirrors the Worker's normalizeMailbox (apps/api/src/services/agent-email/address.ts):
// an address it would refuse gets a permanent 550 here instead of a 451 retry loop.
func plainMailbox(addr string) bool {
	if len(addr) < 3 || len(addr) > 254 || strings.Count(addr, "@") != 1 {
		return false
	}
	at := strings.Index(addr, "@")
	if at == 0 || at == len(addr)-1 {
		return false
	}
	for _, r := range addr {
		if r <= ' ' || r == 0x7f || strings.ContainsRune(`<>()[]\,;:"`, r) {
			return false
		}
	}
	return true
}

// dkimReplayRefusal says why an aligned DKIM pass cannot authenticate this delivery on its own,
// or "". An SPF pass is bound to the sending server and needs none of this; a DKIM signature
// travels with the message, so it must also name this recipient and be recent.
func dkimReplayRefusal(raw []byte, v *dkim.Verification, policy AuthPolicy) string {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return "the message header could not be read"
	}
	if !dkimBindsRecipient(msg.Header, v.HeaderKeys, policy.Recipient) {
		return "the DKIM signature does not name this agent address in a signed To or Cc"
	}
	if !dkimFresh(msg.Header, policy) {
		return "the DKIM-signed message is too old or has no valid Date"
	}
	return ""
}

func dkimBindsRecipient(h mail.Header, signed []string, recipient string) bool {
	recipient = strings.ToLower(strings.TrimSpace(recipient))
	for _, field := range []string{"To", "Cc"} {
		if !signsHeaders(signed, strings.ToLower(field)) {
			continue
		}
		for _, value := range h[field] {
			addrs, err := mail.ParseAddressList(value)
			if err != nil {
				continue
			}
			for _, a := range addrs {
				if strings.ToLower(a.Address) == recipient {
					return true
				}
			}
		}
	}
	return false
}

func dkimFresh(h mail.Header, policy AuthPolicy) bool {
	date, err := h.Date()
	if err != nil {
		return false
	}
	now := time.Now
	if policy.Now != nil {
		now = policy.Now
	}
	age := now().Sub(date)
	// A date far in the future would make any age check pass forever.
	return age <= policy.DKIMMaxAge && age >= -dkimMaxClockSkew
}

// dkimMaxClockSkew is how far ahead of this server's clock a sender's Date may be.
const dkimMaxClockSkew = 15 * time.Minute
