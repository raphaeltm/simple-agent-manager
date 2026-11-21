package main

import (
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/miekg/dns"
)

// testServer runs the real listeners (public and loopback update, UDP and TCP) on 127.0.0.1.
type testServer struct {
	cfg        *Config
	zone       *atomic.Pointer[Zone]
	publicUDP  string
	publicTCP  string
	updateUDP  string
	updateTCP  string
	challenges *Challenges
}

func startTestServer(t *testing.T, cfg *Config) *testServer {
	t.Helper()
	var zone atomic.Pointer[Zone]
	z, _ := BuildZone(cfg, 3, []SyncedRecord{
		{Name: "r1-web-80-env1.apps.box.example.test", Type: "A", Content: "198.51.100.20"},
	})
	zone.Store(z)
	ch := NewChallenges(cfg)
	public := &Handler{cfg: cfg, zone: &zone, challenges: ch, limiter: NewRateLimiter(cfg)}
	loopback := &Handler{cfg: cfg, zone: &zone, challenges: ch, updates: true}
	pub, err := startServers([]string{"127.0.0.1:0"}, public, cfg, dns.DefaultMsgAcceptFunc, nil)
	if err != nil {
		t.Fatal(err)
	}
	upd, err := startServers([]string{"127.0.0.1:0"}, loopback, cfg, updateAcceptFunc,
		map[string]string{cfg.TSIGKeyName: cfg.TSIGSecret})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, s := range append(pub, upd...) {
			_ = s.Shutdown()
		}
	})
	time.Sleep(50 * time.Millisecond) // let ActivateAndServe start
	return &testServer{
		cfg: cfg, zone: &zone, challenges: ch,
		publicUDP: pub[0].PacketConn.LocalAddr().String(), publicTCP: pub[1].Listener.Addr().String(),
		updateUDP: upd[0].PacketConn.LocalAddr().String(), updateTCP: upd[1].Listener.Addr().String(),
	}
}

func exchange(t *testing.T, net, addr string, m *dns.Msg) *dns.Msg {
	t.Helper()
	c := &dns.Client{Net: net, Timeout: 2 * time.Second}
	reply, _, err := c.Exchange(m, addr)
	if err != nil {
		t.Fatalf("%s %s: %v", net, addr, err)
	}
	return reply
}

func query(name string, qtype uint16) *dns.Msg {
	m := new(dns.Msg)
	m.SetQuestion(name, qtype)
	m.RecursionDesired = true
	return m
}

func TestPublicListenerIsAuthoritativeOnly(t *testing.T) {
	s := startTestServer(t, testConfig(t, nil))

	// Owner control: an in-zone answer, authoritative, no recursion offered.
	r := exchange(t, "udp", s.publicUDP, query("r1-web-80-env1.apps.box.example.test.", dns.TypeA))
	if r.Rcode != dns.RcodeSuccess || !r.Authoritative || r.RecursionAvailable || len(r.Answer) != 1 {
		t.Fatalf("in-zone answer: %v", r)
	}
	// No recursion: another zone is refused even with RD set.
	if r := exchange(t, "udp", s.publicUDP, query("www.google.com.", dns.TypeA)); r.Rcode != dns.RcodeRefused || len(r.Answer) != 0 || r.RecursionAvailable {
		t.Fatalf("recursion: %v", r)
	}
	// No zone transfers, over UDP or TCP.
	for _, qt := range []uint16{dns.TypeAXFR, dns.TypeIXFR} {
		if r := exchange(t, "tcp", s.publicTCP, query("box.example.test.", qt)); r.Rcode != dns.RcodeRefused || len(r.Answer) != 0 {
			t.Fatalf("%s over TCP: %v", dns.TypeToString[qt], r)
		}
	}
	// Minimal ANY.
	if r := exchange(t, "udp", s.publicUDP, query("box.example.test.", dns.TypeANY)); len(r.Answer) != 1 || r.Answer[0].Header().Rrtype != dns.TypeHINFO {
		t.Fatalf("ANY: %v", r.Answer)
	}
	// CHAOS (version.bind) is refused.
	m := query("version.bind.", dns.TypeTXT)
	m.Question[0].Qclass = dns.ClassCHAOS
	if r := exchange(t, "udp", s.publicUDP, m); r.Rcode != dns.RcodeRefused {
		t.Fatalf("CHAOS: %v", r)
	}
}

func signedUpdate(cfg *Config, rrs ...dns.RR) *dns.Msg {
	m := new(dns.Msg)
	m.SetUpdate(cfg.Zone)
	m.Insert(rrs)
	m.SetTsig(cfg.TSIGKeyName, dns.HmacSHA256, 300, time.Now().Unix())
	return m
}

func challengeTXT(name, value string) dns.RR {
	return &dns.TXT{Hdr: dns.RR_Header{Name: name, Rrtype: dns.TypeTXT, Class: dns.ClassINET, Ttl: 60}, Txt: []string{value}}
}

func tsigClient(cfg *Config) *dns.Client {
	return &dns.Client{Net: "tcp", Timeout: 2 * time.Second, TsigSecret: map[string]string{cfg.TSIGKeyName: cfg.TSIGSecret}}
}

func TestUpdatesOnlyOnLoopbackWithTSIG(t *testing.T) {
	cfg := testConfig(t, nil)
	s := startTestServer(t, cfg)
	name := "_acme-challenge.box.example.test."

	// The public listener never takes an update, even a correctly signed one.
	pubClient := tsigClient(cfg)
	r, _, err := pubClient.Exchange(signedUpdate(cfg, challengeTXT(name, "via-public")), s.publicTCP)
	if err != nil {
		t.Fatalf("public update exchange: %v", err)
	}
	if r.Rcode == dns.RcodeSuccess {
		t.Fatalf("public listener accepted an update: %v", r)
	}

	// Unsigned update on loopback: refused.
	unsigned := new(dns.Msg)
	unsigned.SetUpdate(cfg.Zone)
	unsigned.Insert([]dns.RR{challengeTXT(name, "unsigned")})
	if r := exchange(t, "tcp", s.updateTCP, unsigned); r.Rcode != dns.RcodeNotAuth {
		t.Fatalf("unsigned update: %s", dns.RcodeToString[r.Rcode])
	}

	// Signed with the wrong key: refused.
	wrong := &dns.Client{Net: "tcp", Timeout: 2 * time.Second, TsigSecret: map[string]string{cfg.TSIGKeyName: "d3Jvbmcta2V5LXdyb25nLWtleS13cm9uZy1rZXktd3Jvbmc="}}
	if r, _, _ := wrong.Exchange(signedUpdate(cfg, challengeTXT(name, "wrong-key")), s.updateTCP); r == nil || r.Rcode == dns.RcodeSuccess {
		t.Fatalf("wrong-key update accepted: %v", r)
	}

	// Signed, but not a challenge name or not TXT: refused, nothing applied.
	for _, rr := range []dns.RR{
		challengeTXT("api.box.example.test.", "hijack"),
		&dns.A{Hdr: dns.RR_Header{Name: name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60}, A: net.ParseIP("192.0.2.66")},
		challengeTXT("_acme-challenge.example.com.", "other-zone"),
	} {
		r, _, err := tsigClient(cfg).Exchange(signedUpdate(cfg, rr), s.updateTCP)
		if err != nil || r.Rcode != dns.RcodeRefused {
			t.Fatalf("update of %s: %v %v", rr.Header().Name, r, err)
		}
	}
	if q := exchange(t, "udp", s.publicUDP, query(name, dns.TypeTXT)); len(q.Answer) != 0 {
		t.Fatalf("a refused update left records: %v", q.Answer)
	}

	// Owner path: Caddy's signed add, then served publicly, then its delete.
	r, _, err = tsigClient(cfg).Exchange(signedUpdate(cfg, challengeTXT(name, "acme-token")), s.updateTCP)
	if err != nil || r.Rcode != dns.RcodeSuccess {
		t.Fatalf("signed add: %v %v", r, err)
	}
	q := exchange(t, "udp", s.publicUDP, query(name, dns.TypeTXT))
	if len(q.Answer) != 1 || q.Answer[0].(*dns.TXT).Txt[0] != "acme-token" || !q.Authoritative {
		t.Fatalf("challenge not served: %v", q.Answer)
	}
	del := new(dns.Msg)
	del.SetUpdate(cfg.Zone)
	del.Remove([]dns.RR{challengeTXT(name, "acme-token")})
	del.SetTsig(cfg.TSIGKeyName, dns.HmacSHA256, 300, time.Now().Unix())
	if r, _, err := tsigClient(cfg).Exchange(del, s.updateTCP); err != nil || r.Rcode != dns.RcodeSuccess {
		t.Fatalf("signed delete: %v %v", r, err)
	}
	if q := exchange(t, "udp", s.publicUDP, query(name, dns.TypeTXT)); len(q.Answer) != 0 {
		t.Fatalf("deleted challenge still served: %v", q.Answer)
	}
}

func TestChallengeStoreIsBounded(t *testing.T) {
	cfg := testConfig(t, map[string]string{"SAM_DNS_MAX_CHALLENGE_VALUES": "2"})
	s := startTestServer(t, cfg)
	name := "_acme-challenge.box.example.test."
	for i, value := range []string{"a", "b"} {
		if r, _, err := tsigClient(cfg).Exchange(signedUpdate(cfg, challengeTXT(name, value)), s.updateTCP); err != nil || r.Rcode != dns.RcodeSuccess {
			t.Fatalf("add %d: %v %v", i, r, err)
		}
	}
	if r, _, _ := tsigClient(cfg).Exchange(signedUpdate(cfg, challengeTXT(name, "c")), s.updateTCP); r == nil || r.Rcode != dns.RcodeRefused {
		t.Fatalf("third value accepted past the bound: %v", r)
	}
}

func TestLargeAnswerIsTruncatedOverUDP(t *testing.T) {
	cfg := testConfig(t, map[string]string{"SAM_DNS_MAX_CHALLENGE_VALUES": "10"})
	s := startTestServer(t, cfg)
	name := "_acme-challenge.box.example.test."
	long := make([]byte, 200)
	for i := range long {
		long[i] = 'x'
	}
	for i := 0; i < 8; i++ {
		v := string(long[:190]) + string(rune('a'+i))
		if r, _, err := tsigClient(cfg).Exchange(signedUpdate(cfg, challengeTXT(name, v)), s.updateTCP); err != nil || r.Rcode != dns.RcodeSuccess {
			t.Fatalf("add %d: %v %v", i, r, err)
		}
	}
	// No EDNS: 512 bytes, so the UDP answer is truncated and the full answer needs TCP.
	udp := exchange(t, "udp", s.publicUDP, query(name, dns.TypeTXT))
	if !udp.Truncated {
		t.Fatalf("UDP answer of %d records not truncated", len(udp.Answer))
	}
	tcp := exchange(t, "tcp", s.publicTCP, query(name, dns.TypeTXT))
	if tcp.Truncated || len(tcp.Answer) != 8 {
		t.Fatalf("TCP answer: truncated=%v records=%d", tcp.Truncated, len(tcp.Answer))
	}
}
