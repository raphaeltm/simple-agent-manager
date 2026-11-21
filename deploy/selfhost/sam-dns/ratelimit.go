package main

import (
	"net"
	"sync"
	"time"
)

type rateVerdict int

const (
	rateAllow rateVerdict = iota
	rateDrop
	rateSlip // answer with an empty truncated reply so a real resolver retries over TCP
)

// RateLimiter is a response rate limiter: one token bucket per client prefix (/24 for IPv4, /56
// for IPv6, so one spoofed source cannot dodge it by varying its last bits). Over the limit, most
// responses are dropped and every slip-th one is a tiny truncated reply, which gives an attacker
// spoofing a victim's address no amplification while a real resolver still gets an answer over TCP.
// The table is bounded: past its size, idle entries are evicted, and if none can be, new prefixes
// share one overflow bucket.
type RateLimiter struct {
	mu       sync.Mutex
	rate     float64
	burst    float64
	max      int
	slip     int
	buckets  map[string]*bucket
	overflow *bucket
	now      func() time.Time
	// lastEvict bounds the full-table scan to once per second, so a flood of new prefixes
	// against a full table cannot turn every packet into a 50,000-entry walk.
	lastEvict time.Time
}

type bucket struct {
	tokens  float64
	updated time.Time
	limited int
}

func NewRateLimiter(cfg *Config) *RateLimiter {
	return &RateLimiter{
		rate:    float64(cfg.RateLimit),
		burst:   float64(cfg.RateBurst),
		max:     cfg.RateTracked,
		slip:    cfg.RateSlip,
		buckets: map[string]*bucket{},
		now:     time.Now,
	}
}

func prefixKey(ip net.IP) string {
	if ip == nil {
		return "unknown"
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.Mask(net.CIDRMask(24, 32)).String()
	}
	return ip.Mask(net.CIDRMask(56, 128)).String()
}

func (l *RateLimiter) refill(b *bucket, now time.Time) {
	b.tokens += now.Sub(b.updated).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.updated = now
}

// evictLocked removes buckets that have refilled completely: they carry no state worth keeping.
func (l *RateLimiter) evictLocked(now time.Time) {
	for key, b := range l.buckets {
		l.refill(b, now)
		if b.tokens >= l.burst {
			delete(l.buckets, key)
		}
	}
}

func (l *RateLimiter) Allow(ip net.IP) rateVerdict {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	key := prefixKey(ip)
	b := l.buckets[key]
	if b == nil {
		if len(l.buckets) >= l.max && now.Sub(l.lastEvict) >= time.Second {
			l.lastEvict = now
			l.evictLocked(now)
		}
		if len(l.buckets) >= l.max {
			if l.overflow == nil {
				l.overflow = &bucket{tokens: l.burst, updated: now}
			}
			b = l.overflow
		} else {
			b = &bucket{tokens: l.burst, updated: now}
			l.buckets[key] = b
		}
	}
	l.refill(b, now)
	if b.tokens >= 1 {
		b.tokens--
		b.limited = 0
		return rateAllow
	}
	b.limited++
	if l.slip > 0 && b.limited%l.slip == 0 {
		return rateSlip
	}
	return rateDrop
}
