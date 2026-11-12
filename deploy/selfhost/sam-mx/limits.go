package main

import (
	"net"
	"sync"
	"time"
)

// limitedListener refuses connections over the concurrency cap or the per-address rate with a
// 421 greeting and closes them, before go-smtp sees them.
type limitedListener struct {
	net.Listener
	cfg *Config
	now func() time.Time

	mu     sync.Mutex
	active int
	window time.Time
	perIP  map[string]int
}

func newLimitedListener(l net.Listener, cfg *Config) *limitedListener {
	return &limitedListener{Listener: l, cfg: cfg, now: time.Now, perIP: map[string]int{}}
}

func clientKey(addr net.Addr) string {
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}

// admit records a new connection; false with a reason when it must be refused.
func (l *limitedListener) admit(key string) (bool, string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.window) >= time.Minute {
		l.window = now
		l.perIP = map[string]int{}
	}
	if l.active >= l.cfg.MaxConnections {
		return false, "421 4.7.0 Too many connections, try again later\r\n"
	}
	count, seen := l.perIP[key]
	if !seen && len(l.perIP) >= l.cfg.MaxTrackedIPs {
		return false, "421 4.7.0 Too many clients, try again later\r\n"
	}
	if count >= l.cfg.ConnPerIPPerMin {
		return false, "421 4.7.0 Too many connections from your address, try again later\r\n"
	}
	l.perIP[key] = count + 1
	l.active++
	return true, ""
}

func (l *limitedListener) release() {
	l.mu.Lock()
	l.active--
	l.mu.Unlock()
}

func (l *limitedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		ok, refusal := l.admit(clientKey(conn.RemoteAddr()))
		if !ok {
			_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_, _ = conn.Write([]byte(refusal))
			_ = conn.Close()
			continue
		}
		return &trackedConn{Conn: conn, release: l.release}, nil
	}
}

type trackedConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *trackedConn) Close() error {
	c.once.Do(c.release)
	return c.Conn.Close()
}
