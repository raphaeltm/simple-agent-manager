package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"strings"

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
	// The domain of the message's single From address, lower case. The Worker requires the From
	// it parses to have this domain, so the two parsers cannot disagree about who sent it.
	FromDomain string
	SPF        string
	DKIM       string
}

// AuthError is a refusal: Temporary means 451 (retry later), otherwise 550.
type AuthError struct {
	Temporary bool
	Reason    string
}

func (e *AuthError) Error() string { return e.Reason }

func permFail(reason string) error { return &AuthError{Reason: reason} }
func tempFail(reason string) error { return &AuthError{Temporary: true, Reason: reason} }

// FromDomain parses the header block and returns the domain of the single From address.
func FromDomain(raw []byte) (string, error) {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return "", permFail("the message header could not be read")
	}
	fromHeaders := msg.Header["From"]
	if len(fromHeaders) != 1 {
		return "", permFail("exactly one From header is required")
	}
	addrs, err := mail.ParseAddressList(fromHeaders[0])
	if err != nil || len(addrs) != 1 {
		return "", permFail("exactly one From address is required")
	}
	return domainOf(addrs[0].Address)
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
// (RFC 7489 6.6.3). A missing record is (nil, nil): alignment is still required, in relaxed mode.
func lookupDMARC(ctx context.Context, r Resolver, fromDomain string) (*dmarc.Record, error) {
	opts := &dmarc.LookupOptions{LookupTXT: func(name string) ([]string, error) {
		return r.LookupTXT(ctx, name)
	}}
	for _, domain := range []string{fromDomain, orgDomain(fromDomain)} {
		record, err := dmarc.LookupWithOptions(domain, opts)
		if err == nil {
			return record, nil
		}
		if dmarc.IsTempFail(err) {
			return nil, err
		}
		if domain == orgDomain(fromDomain) {
			break
		}
	}
	return nil, nil
}

// Authenticate decides whether the message's From domain is authenticated: SPF (for the
// envelope sender) or DKIM pass, aligned with the From domain. This is DMARC's pass condition,
// required whatever policy the domain publishes: the trigger's sender allowlist compares From
// addresses, so an unaligned pass would let anyone with their own SPF record send as an allowed
// sender. Cloudflare Email Routing, which the Worker relied on before, enforces published DMARC
// policies; this is stricter on purpose.
func Authenticate(ctx context.Context, r Resolver, ip net.IP, helo, envelopeFrom string, raw []byte, trusted bool) (*AuthVerdict, error) {
	fromDomain, err := FromDomain(raw)
	if err != nil {
		return nil, err
	}
	if trusted {
		return &AuthVerdict{Result: "trusted", FromDomain: fromDomain, SPF: "none", DKIM: "none"}, nil
	}

	verdict := &AuthVerdict{FromDomain: fromDomain, SPF: "none", DKIM: "none"}
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

	var dkimPassDomains []string
	verifications, dkimErr := dkim.VerifyWithOptions(bytes.NewReader(raw), &dkim.VerifyOptions{
		LookupTXT:        func(name string) ([]string, error) { return r.LookupTXT(ctx, name) },
		MaxVerifications: 5,
	})
	if dkimErr != nil && !errors.Is(dkimErr, dkim.ErrTooManySignatures) {
		verdict.DKIM = "permerror"
	}
	for _, v := range verifications {
		switch {
		case v.Err == nil:
			dkimPassDomains = append(dkimPassDomains, v.Domain)
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

	record, dmarcErr := lookupDMARC(ctx, r, fromDomain)
	if dmarcErr != nil {
		return nil, tempFail("the sender's DMARC policy could not be read; try again later")
	}
	var spfMode, dkimMode dmarc.AlignmentMode = dmarc.AlignmentRelaxed, dmarc.AlignmentRelaxed
	if record != nil {
		if record.SPFAlignment != "" {
			spfMode = record.SPFAlignment
		}
		if record.DKIMAlignment != "" {
			dkimMode = record.DKIMAlignment
		}
	}

	if spfResult == spf.Pass && aligned(spfDomain, fromDomain, spfMode) {
		verdict.Result = "pass"
		return verdict, nil
	}
	for _, d := range dkimPassDomains {
		if aligned(d, fromDomain, dkimMode) {
			verdict.Result = "pass"
			return verdict, nil
		}
	}
	if temporary {
		return nil, tempFail("sender authentication could not be completed; try again later")
	}
	return nil, permFail(fmt.Sprintf("sender authentication failed for %s (no aligned SPF or DKIM pass)", fromDomain))
}
