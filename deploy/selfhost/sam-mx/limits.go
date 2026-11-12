package main

import (
	"net"
	"sync"
	"time"
)

// overflowKey is the shared bucket for client addresses seen after MaxTrackedIPs distinct ones
// in a window: a flood of fresh addresses (an IPv6 /64 has plenty) then degrades to one shared
// rate instead of locking every new sender out.
const overflowKey = "overflow"

// limitedListener refuses connections over the global cap, the per-client concurrency cap or
// the per-client rate with a 421 greeting, before go-smtp sees them, and closes every
// connection after the maximum session lifetime.
type limitedListener struct {
	net.Listener
	cfg *Config
	now func() time.Time

	mu       sync.Mutex
	active   int
	activeBy map[string]int
	window   time.Time
	perIP    map[string]int
}

func newLimitedListener(l net.Listener, cfg *Config) *limitedListener {
	return &limitedListener{
		Listener: l, cfg: cfg, now: time.Now,
		activeBy: map[string]int{}, perIP: map[string]int{},
	}
}

// clientKey is the client's IPv4 address, or its IPv6 /64: one IPv6 host controls a whole /64.
func clientKey(addr net.Addr) string {
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return host
	}
	if ip4 := ip.To4(); ip4 != nil {
		return ip4.String()
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

// admit records a new connection; returns the bucket it was counted in, or a refusal.
func (l *limitedListener) admit(key string) (string, string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.window) >= time.Minute {
		l.window = now
		l.perIP = map[string]int{}
	}
	if l.active >= l.cfg.MaxConnections {
		return "", "421 4.7.0 Too many connections, try again later\r\n"
	}
	if l.activeBy[key] >= l.cfg.MaxConnectionsPerIP {
		return "", "421 4.7.0 Too many open connections from your address, try again later\r\n"
	}
	bucket := key
	if _, seen := l.perIP[key]; !seen && len(l.perIP) >= l.cfg.MaxTrackedIPs {
		bucket = overflowKey
	}
	if l.perIP[bucket] >= l.cfg.ConnPerIPPerMin {
		return "", "421 4.7.0 Too many connections, try again later\r\n"
	}
	l.perIP[bucket]++
	l.active++
	l.activeBy[key]++
	return key, ""
}

func (l *limitedListener) release(key string) {
	l.mu.Lock()
	l.active--
	if l.activeBy[key]--; l.activeBy[key] <= 0 {
		delete(l.activeBy, key)
	}
	l.mu.Unlock()
}

func (l *limitedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		key, refusal := l.admit(clientKey(conn.RemoteAddr()))
		if refusal != "" {
			_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_, _ = conn.Write([]byte(refusal))
			_ = conn.Close()
			continue
		}
		tc := &trackedConn{Conn: conn, release: func() { l.release(key) }}
		// go-smtp resets the read deadline on every command, so a client sending one command a
		// minute could hold a slot forever. The lifetime bound covers DATA, DNS and the gateway.
		tc.timer = time.AfterFunc(l.cfg.MaxSessionDuration, func() { _ = tc.Close() })
		return tc, nil
	}
}

type trackedConn struct {
	net.Conn
	once    sync.Once
	timer   *time.Timer
	release func()
}

func (c *trackedConn) Close() error {
	c.once.Do(func() {
		if c.timer != nil {
			c.timer.Stop()
		}
		c.release()
	})
	return c.Conn.Close()
}
