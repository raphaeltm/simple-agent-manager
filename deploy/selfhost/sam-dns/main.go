// sam-dns: the authoritative DNS server for a self-hosted SAM box (deploy/selfhost, profile dns).
//
// The operator delegates SAM_DOMAIN to the box once (an NS record plus glue in the parent zone).
// sam-dns then answers for it:
//   - static records: SOA, NS ns1.SAM_DOMAIN, the ns1 glue and *.SAM_DOMAIN, all to the box;
//   - the records the Worker keeps in D1 (app routes, node backends), synced by polling the
//     loopback gateway route GET /api/self-host/gateway/dns-records, never per query;
//   - ACME DNS-01 TXT records, written by Caddy over RFC 2136 with TSIG on a loopback listener.
//
// Authoritative only: no recursion, no zone transfers, minimal ANY answers, response rate limiting
// on the public listener. Threat model: tasks/active/2026-11-21-selfhost-box-dns.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/miekg/dns"
)

// limitedListener caps concurrent TCP connections, in total and per client prefix (/24 IPv4,
// /56 IPv6, as the rate limiter), so a client cannot exhaust the server by opening connections
// from many addresses of its own network.
type limitedListener struct {
	net.Listener
	mu     sync.Mutex
	total  int
	perIP  map[string]int
	max    int
	maxPer int
}

type limitedConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *limitedConn) Close() error {
	c.once.Do(c.release)
	return c.Conn.Close()
}

func newLimitedListener(ln net.Listener, max, maxPer int) *limitedListener {
	return &limitedListener{Listener: ln, perIP: map[string]int{}, max: max, maxPer: maxPer}
}

func (l *limitedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		var ip net.IP
		if addr, ok := conn.RemoteAddr().(*net.TCPAddr); ok {
			ip = addr.IP
		}
		host := prefixKey(ip)
		l.mu.Lock()
		if l.total >= l.max || l.perIP[host] >= l.maxPer {
			l.mu.Unlock()
			_ = conn.Close()
			continue
		}
		l.total++
		l.perIP[host]++
		l.mu.Unlock()
		return &limitedConn{Conn: conn, release: func() {
			l.mu.Lock()
			l.total--
			if l.perIP[host]--; l.perIP[host] <= 0 {
				delete(l.perIP, host)
			}
			l.mu.Unlock()
		}}, nil
	}
}

// startServers starts one UDP and one TCP server per address.
func startServers(addrs []string, handler dns.Handler, cfg *Config, accept dns.MsgAcceptFunc, tsig map[string]string) ([]*dns.Server, error) {
	var servers []*dns.Server
	for _, addr := range addrs {
		pc, err := net.ListenPacket("udp", addr)
		if err != nil {
			return servers, fmt.Errorf("listen udp %s: %w", addr, err)
		}
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			_ = pc.Close()
			return servers, fmt.Errorf("listen tcp %s: %w", addr, err)
		}
		idle := cfg.TCPIdleTimeout
		for _, s := range []*dns.Server{
			{PacketConn: pc, Handler: handler, UDPSize: dns.DefaultMsgSize, MsgAcceptFunc: accept, TsigSecret: tsig},
			{Listener: newLimitedListener(ln, cfg.TCPMaxConnections, cfg.TCPMaxPerIP), Handler: handler,
				MsgAcceptFunc: accept, TsigSecret: tsig, MaxTCPQueries: cfg.TCPMaxQueries,
				ReadTimeout: idle, WriteTimeout: idle, IdleTimeout: func() time.Duration { return idle }},
		} {
			server := s
			servers = append(servers, server)
			go func() {
				if err := server.ActivateAndServe(); err != nil {
					slog.Error("sam-dns: server stopped", "addr", addr, "error", err.Error())
				}
			}()
		}
	}
	return servers, nil
}

// healthcheck asks the loopback listener for the zone's SOA (docker-compose healthcheck).
func healthcheck(cfg *Config) error {
	m := new(dns.Msg)
	m.SetQuestion(cfg.Zone, dns.TypeSOA)
	c := &dns.Client{Timeout: 2 * time.Second}
	reply, _, err := c.Exchange(m, cfg.UpdateListen)
	if err != nil {
		return err
	}
	if reply.Rcode != dns.RcodeSuccess || !reply.Authoritative || len(reply.Answer) != 1 {
		return errors.New("unexpected SOA answer")
	}
	return nil
}

// probeUpdate sends a TSIG-signed no-op UPDATE (delete a TXT RRset at a probe name that never
// holds a live challenge) to the loopback listener. `pnpm selfhost:secrets rotate dns-update-key`
// runs it to prove which key the running server accepts. Exit 0: accepted; 3: refused (NOTAUTH).
func probeUpdate(cfg *Config, secret string) (bool, error) {
	m := new(dns.Msg)
	m.SetUpdate(cfg.Zone)
	m.RemoveRRset([]dns.RR{&dns.ANY{Hdr: dns.RR_Header{
		Name: challengePrefix + "sam-dns-probe." + cfg.Zone, Rrtype: dns.TypeTXT, Class: dns.ClassANY,
	}}})
	m.SetTsig(cfg.TSIGKeyName, dns.HmacSHA256, 300, time.Now().Unix())
	c := &dns.Client{Net: "tcp", Timeout: 3 * time.Second, TsigSecret: map[string]string{cfg.TSIGKeyName: secret}}
	reply, _, err := c.Exchange(m, cfg.UpdateListen)
	if reply != nil && reply.Rcode == dns.RcodeNotAuth {
		return false, nil // refused before the reply could be signed with our key
	}
	if err != nil {
		return false, err
	}
	return reply.Rcode == dns.RcodeSuccess, nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg, err := LoadConfig(os.Getenv)
	if err != nil {
		slog.Error("sam-dns: configuration error", "error", err.Error())
		os.Exit(64)
	}
	if len(os.Args) > 1 && os.Args[1] == "probe-update" {
		// The key to try comes from the environment, never argv, and must be given: falling back
		// to the server's own key would make the rotation's "new key accepted" check vacuous.
		secret := os.Getenv("SAM_DNS_PROBE_TSIG_SECRET")
		if secret == "" {
			fmt.Fprintln(os.Stderr, "sam-dns probe-update: SAM_DNS_PROBE_TSIG_SECRET is not set")
			os.Exit(64)
		}
		ok, err := probeUpdate(cfg, secret)
		if err != nil {
			fmt.Fprintln(os.Stderr, "sam-dns probe-update:", err)
			os.Exit(1)
		}
		if !ok {
			fmt.Println("refused")
			os.Exit(3)
		}
		fmt.Println("accepted")
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		if err := healthcheck(cfg); err != nil {
			fmt.Fprintln(os.Stderr, "sam-dns healthcheck:", err)
			os.Exit(1)
		}
		return
	}
	publicAddrs, err := listenAddresses(cfg.Listen, net.InterfaceAddrs)
	if err != nil {
		slog.Error("sam-dns: configuration error", "error", err.Error())
		os.Exit(64)
	}

	var zone atomic.Pointer[Zone]
	initial, _ := BuildZone(cfg, 0, nil)
	zone.Store(initial)
	syncer := NewSyncer(cfg, &zone)
	syncer.LoadCache()

	challenges := NewChallenges(cfg)
	public := &Handler{cfg: cfg, zone: &zone, challenges: challenges, limiter: NewRateLimiter(cfg)}
	loopback := &Handler{cfg: cfg, zone: &zone, challenges: challenges, updates: true}

	// The public listener uses the library's default accept function: UPDATE is answered NOTIMP
	// before its sections are parsed, and it never sees the TSIG key.
	servers, err := startServers(publicAddrs, public, cfg, dns.DefaultMsgAcceptFunc, nil)
	if err == nil {
		var more []*dns.Server
		more, err = startServers([]string{cfg.UpdateListen}, loopback, cfg, updateAcceptFunc,
			map[string]string{cfg.TSIGKeyName: cfg.TSIGSecret})
		servers = append(servers, more...)
	}
	if err != nil {
		slog.Error("sam-dns: listen failed", "error", err.Error())
		os.Exit(1)
	}
	// The addresses are resolved once: after the box gains or changes an address, restart sam-dns.
	slog.Info("sam-dns: serving", "zone", cfg.Zone, "public", publicAddrs, "update", cfg.UpdateListen,
		"ttl", cfg.TTL)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	synced := make(chan struct{})
	go func() {
		defer close(synced)
		syncer.Run(ctx)
	}()
	<-ctx.Done()
	<-synced // a cache write in progress finishes (or removes its temp file) first
	shutdown, done := context.WithTimeout(context.Background(), cfg.ShutdownGrace)
	defer done()
	for _, s := range servers {
		_ = s.ShutdownContext(shutdown)
	}
}
