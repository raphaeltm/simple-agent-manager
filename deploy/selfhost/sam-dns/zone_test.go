package main

import (
	"encoding/base64"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/miekg/dns"
)

// testTSIGSecret is built at run time so no key-shaped literal sits in the tree (gitleaks).
var testTSIGSecret = base64.StdEncoding.EncodeToString([]byte(strings.Repeat("sam-dns-test-key", 3)[:40]))

func testEnv(overrides map[string]string) func(string) string {
	env := map[string]string{
		"SAM_DOMAIN":                    "box.example.test",
		"SAM_DNS_PUBLIC_IPV4":           "203.0.113.5",
		"SAM_DNS_LISTEN":                "127.0.0.1:5300",
		"SAM_DNS_UPDATE_LISTEN":         "127.0.0.1:0",
		"SAM_DNS_TSIG_SECRET":           testTSIGSecret,
		"REVERSE_TUNNEL_GATEWAY_SECRET": strings.Repeat("g", 64),
	}
	for k, v := range overrides {
		env[k] = v
	}
	return func(k string) string { return env[k] }
}

func testConfig(t *testing.T, overrides map[string]string) *Config {
	t.Helper()
	cfg, err := LoadConfig(testEnv(overrides))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	return cfg
}

func aContents(rrs []dns.RR) []string {
	var out []string
	for _, rr := range rrs {
		if a, ok := rr.(*dns.A); ok {
			out = append(out, a.Hdr.Name+"="+a.A.String())
		}
	}
	return out
}

func TestLookupStaticWildcardAndSynced(t *testing.T) {
	cfg := testConfig(t, nil)
	zone, skipped := BuildZone(cfg, 7, []SyncedRecord{
		{Name: "r1-web-80-env1.apps.box.example.test", Type: "A", Content: "198.51.100.20"},
		{Name: "node1.vm.box.example.test", Type: "A", Content: "198.51.100.30"},
	})
	if skipped != 0 {
		t.Fatalf("skipped %d", skipped)
	}

	cases := []struct {
		name, q string
		qtype   uint16
		rcode   int
		want    []string
	}{
		{"app route", "r1-web-80-env1.apps.box.example.test.", dns.TypeA, dns.RcodeSuccess, []string{"r1-web-80-env1.apps.box.example.test.=198.51.100.20"}},
		{"case insensitive", "R1-WEB-80-ENV1.apps.BOX.example.test.", dns.TypeA, dns.RcodeSuccess, []string{"r1-web-80-env1.apps.box.example.test.=198.51.100.20"}},
		{"api via wildcard", "api.box.example.test.", dns.TypeA, dns.RcodeSuccess, []string{"api.box.example.test.=203.0.113.5"}},
		{"workspace via wildcard", "ws-abc.box.example.test.", dns.TypeA, dns.RcodeSuccess, []string{"ws-abc.box.example.test.=203.0.113.5"}},
		{"glue", "ns1.box.example.test.", dns.TypeA, dns.RcodeSuccess, []string{"ns1.box.example.test.=203.0.113.5"}},
		// apps.<apex> is an empty non-terminal: it exists (NODATA), and names below it that do not
		// exist are NXDOMAIN, not the wildcard (RFC 4592 closest encloser).
		{"empty non-terminal", "apps.box.example.test.", dns.TypeA, dns.RcodeSuccess, nil},
		{"under ENT is NXDOMAIN", "unknown.apps.box.example.test.", dns.TypeA, dns.RcodeNameError, nil},
		{"wildcard NODATA for TXT", "api.box.example.test.", dns.TypeTXT, dns.RcodeSuccess, nil},
		{"apex has no A", "box.example.test.", dns.TypeA, dns.RcodeSuccess, nil},
		{"out of zone refused", "example.com.", dns.TypeA, dns.RcodeRefused, nil},
		{"parent zone refused", "example.test.", dns.TypeSOA, dns.RcodeRefused, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := zone.Lookup(tc.q, tc.qtype, nil)
			if got.Rcode != tc.rcode {
				t.Fatalf("rcode %s, want %s", dns.RcodeToString[got.Rcode], dns.RcodeToString[tc.rcode])
			}
			if strings.Join(aContents(got.Answer), ",") != strings.Join(tc.want, ",") {
				t.Fatalf("answer %v, want %v", aContents(got.Answer), tc.want)
			}
			if tc.rcode != dns.RcodeRefused && len(got.Answer) == 0 {
				if len(got.Authority) != 1 || got.Authority[0].Header().Rrtype != dns.TypeSOA {
					t.Fatalf("negative answer without SOA: %v", got.Authority)
				}
				if got.Authority[0].Header().Ttl != cfg.NegativeTTL {
					t.Fatalf("negative TTL %d, want %d", got.Authority[0].Header().Ttl, cfg.NegativeTTL)
				}
			}
		})
	}
	soa := zone.Lookup("box.example.test.", dns.TypeSOA, nil)
	if len(soa.Answer) != 1 || soa.Answer[0].(*dns.SOA).Serial != 7 {
		t.Fatalf("SOA serial: %v", soa.Answer)
	}
	if got := zone.Lookup("r1-web-80-env1.apps.box.example.test.", dns.TypeA, nil); got.Answer[0].Header().Ttl != cfg.TTL {
		t.Fatalf("TTL %d, want the long TTL %d", got.Answer[0].Header().Ttl, cfg.TTL)
	}
}

func TestLookupANYIsMinimal(t *testing.T) {
	cfg := testConfig(t, nil)
	zone, _ := BuildZone(cfg, 1, nil)
	for _, q := range []string{"box.example.test.", "api.box.example.test."} {
		got := zone.Lookup(q, dns.TypeANY, nil)
		if len(got.Answer) != 1 || got.Answer[0].Header().Rrtype != dns.TypeHINFO {
			t.Fatalf("%s ANY: %v, want one RFC 8482 HINFO", q, got.Answer)
		}
	}
}

func TestSyncedRecordsCannotTakeStaticOrChallengeNames(t *testing.T) {
	cfg := testConfig(t, nil)
	zone, skipped := BuildZone(cfg, 2, []SyncedRecord{
		{Name: "box.example.test", Type: "A", Content: "192.0.2.66"},
		{Name: "ns1.box.example.test", Type: "A", Content: "192.0.2.66"},
		{Name: "*.box.example.test", Type: "A", Content: "192.0.2.66"},
		{Name: "_acme-challenge.box.example.test", Type: "A", Content: "192.0.2.66"},
		{Name: "other.example.com", Type: "A", Content: "192.0.2.66"},
		{Name: "bad-ip.apps.box.example.test", Type: "A", Content: "not-an-ip"},
		{Name: "v6.apps.box.example.test", Type: "AAAA", Content: "2001:db8::1"},
		{Name: "api.box.example.test", Type: "A", Content: "192.0.2.66"},
		{Name: "app.box.example.test", Type: "A", Content: "192.0.2.66"},
		{Name: "a.b.apps.box.example.test", Type: "A", Content: "192.0.2.66"},
		{Name: "ok.apps.box.example.test", Type: "A", Content: "192.0.2.10"},
	})
	if skipped != 10 {
		t.Fatalf("skipped %d, want 10", skipped)
	}
	// api. is still the box (the wildcard), never the bad row.
	if got := aContents(zone.Lookup("api.box.example.test.", dns.TypeA, nil).Answer); strings.Join(got, ",") != "api.box.example.test.=203.0.113.5" {
		t.Fatalf("api overridden: %v", got)
	}
	if got := aContents(zone.Lookup("ns1.box.example.test.", dns.TypeA, nil).Answer); strings.Join(got, ",") != "ns1.box.example.test.=203.0.113.5" {
		t.Fatalf("glue overridden: %v", got)
	}
	// Liveness: the valid record next to the bad ones is served.
	if got := aContents(zone.Lookup("ok.apps.box.example.test.", dns.TypeA, nil).Answer); len(got) != 1 {
		t.Fatalf("valid record lost: %v", got)
	}
}

func TestChallengesServeTXTAndExpire(t *testing.T) {
	cfg := testConfig(t, nil)
	zone, _ := BuildZone(cfg, 1, nil)
	ch := NewChallenges(cfg)
	now := time.Unix(1_800_000_000, 0)
	ch.now = func() time.Time { return now }
	if !ch.apply([]challengeOp{{name: "_acme-challenge.box.example.test.", add: true, txt: []string{"token-1"}}}) {
		t.Fatal("apply refused")
	}
	got := zone.Lookup("_acme-challenge.box.example.test.", dns.TypeTXT, ch)
	if len(got.Answer) != 1 || got.Answer[0].(*dns.TXT).Txt[0] != "token-1" {
		t.Fatalf("challenge TXT: %v", got.Answer)
	}
	// The challenge name is a real node: A is NODATA, not the wildcard.
	if a := zone.Lookup("_acme-challenge.box.example.test.", dns.TypeA, ch); len(a.Answer) != 0 || a.Rcode != dns.RcodeSuccess {
		t.Fatalf("challenge name A: %v %d", a.Answer, a.Rcode)
	}
	// A challenge never hides its parent from the wildcard (security review L1).
	ch.apply([]challengeOp{{name: "_acme-challenge.app.box.example.test.", add: true, txt: []string{"x"}}})
	if got := aContents(zone.Lookup("app.box.example.test.", dns.TypeA, ch).Answer); len(got) != 1 {
		t.Fatalf("app. shadowed by a challenge below it: %v", got)
	}
	now = now.Add(cfg.ChallengeMaxAge + time.Second)
	if got := zone.Lookup("_acme-challenge.box.example.test.", dns.TypeTXT, ch); len(got.Answer) != 0 {
		t.Fatalf("expired challenge still served: %v", got.Answer)
	}
}

func TestListenAddressesAuto(t *testing.T) {
	addrs := func() ([]net.Addr, error) {
		return []net.Addr{
			&net.IPNet{IP: net.ParseIP("127.0.0.1"), Mask: net.CIDRMask(8, 32)},
			&net.IPNet{IP: net.ParseIP("10.132.0.5"), Mask: net.CIDRMask(32, 32)},
			&net.IPNet{IP: net.ParseIP("fe80::1"), Mask: net.CIDRMask(64, 128)},
			&net.IPNet{IP: net.ParseIP("2001:db8::5"), Mask: net.CIDRMask(64, 128)},
		}, nil
	}
	got, err := listenAddresses([]string{"auto"}, addrs)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "10.132.0.5:53,[2001:db8::5]:53" {
		t.Fatalf("auto listen: %v", got)
	}
}

func TestConfigRefusesUnsafeSettings(t *testing.T) {
	cases := map[string]map[string]string{
		"update listener off loopback": {"SAM_DNS_UPDATE_LISTEN": "0.0.0.0:8053"},
		"update listener on public IP": {"SAM_DNS_UPDATE_LISTEN": "203.0.113.5:8053"},
		"short TSIG key":               {"SAM_DNS_TSIG_SECRET": "c2hvcnQ="},
		"missing TSIG key":             {"SAM_DNS_TSIG_SECRET": ""},
		"missing public IP":            {"SAM_DNS_PUBLIC_IPV4": ""},
		"missing domain":               {"SAM_DOMAIN": ""},
		"short gateway secret":         {"REVERSE_TUNNEL_GATEWAY_SECRET": "short"},
		"page above gateway ceiling":   {"SAM_DNS_SYNC_PAGE_SIZE": "1001"},
	}
	for name, overrides := range cases {
		if _, err := LoadConfig(testEnv(overrides)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Owner control: the defaults load.
	if _, err := LoadConfig(testEnv(nil)); err != nil {
		t.Fatalf("defaults refused: %v", err)
	}
}

func TestOutOfZoneNameServerNeedsNoGlue(t *testing.T) {
	cfg := testConfig(t, map[string]string{"SAM_DNS_NAMESERVER": "sam-ns.example.test"})
	zone, _ := BuildZone(cfg, 1, nil)
	ns := zone.Lookup("box.example.test.", dns.TypeNS, nil)
	if len(ns.Answer) != 1 || ns.Answer[0].(*dns.NS).Ns != "sam-ns.example.test." {
		t.Fatalf("NS: %v", ns.Answer)
	}
	soa := zone.Lookup("box.example.test.", dns.TypeSOA, nil)
	if soa.Answer[0].(*dns.SOA).Ns != "sam-ns.example.test." {
		t.Fatalf("SOA mname: %v", soa.Answer)
	}
	// ns1.<zone> is no longer special: it is an ordinary wildcard name.
	if got := aContents(zone.Lookup("ns1.box.example.test.", dns.TypeA, nil).Answer); len(got) != 1 {
		t.Fatalf("ns1 via wildcard: %v", got)
	}
	if _, err := LoadConfig(testEnv(map[string]string{"SAM_DNS_NAMESERVER": "localhost"})); err == nil {
		t.Fatal("single-label name server accepted")
	}
}
