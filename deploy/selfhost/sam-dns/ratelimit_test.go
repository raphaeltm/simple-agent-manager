package main

import (
	"net"
	"testing"
	"time"
)

func TestRateLimiterPerPrefixWithSlip(t *testing.T) {
	cfg := testConfig(t, map[string]string{"SAM_DNS_RATE_LIMIT": "5", "SAM_DNS_RATE_BURST": "5", "SAM_DNS_RATE_SLIP": "2"})
	l := NewRateLimiter(cfg)
	now := time.Unix(1_800_000_000, 0)
	l.now = func() time.Time { return now }

	attacker := net.ParseIP("198.51.100.7")
	neighbour := net.ParseIP("198.51.100.200") // same /24: shares the bucket
	other := net.ParseIP("203.0.113.9")
	for i := 0; i < 5; i++ {
		if v := l.Allow(attacker); v != rateAllow {
			t.Fatalf("request %d within burst: %v", i, v)
		}
	}
	var drops, slips int
	for i := 0; i < 10; i++ {
		switch l.Allow(neighbour) {
		case rateDrop:
			drops++
		case rateSlip:
			slips++
		default:
			t.Fatal("over-limit prefix answered in full")
		}
	}
	if drops != 5 || slips != 5 {
		t.Fatalf("drops %d slips %d, want 5/5 with slip 2", drops, slips)
	}
	// Control: another prefix is unaffected.
	if v := l.Allow(other); v != rateAllow {
		t.Fatalf("unrelated prefix limited: %v", v)
	}
	// Refill after a second.
	now = now.Add(time.Second)
	if v := l.Allow(attacker); v != rateAllow {
		t.Fatalf("no refill: %v", v)
	}
}

func TestRateLimiterTableIsBounded(t *testing.T) {
	cfg := testConfig(t, map[string]string{"SAM_DNS_RATE_TRACKED_PREFIXES": "3", "SAM_DNS_RATE_BURST": "1", "SAM_DNS_RATE_LIMIT": "1"})
	l := NewRateLimiter(cfg)
	now := time.Unix(1_800_000_000, 0)
	l.now = func() time.Time { return now }
	for i := 0; i < 100; i++ {
		l.Allow(net.IPv4(10, byte(i), 0, 1))
	}
	if len(l.buckets) > 3 {
		t.Fatalf("tracked %d prefixes past the bound of 3", len(l.buckets))
	}
	// Spoofed sources beyond the table share the overflow bucket, so they are limited together.
	if v := l.Allow(net.IPv4(10, 200, 0, 1)); v == rateAllow {
		t.Fatal("overflow bucket did not limit")
	}
}

func TestRateLimiterEvictsIdleBucketsBeforeOverflowing(t *testing.T) {
	cfg := testConfig(t, map[string]string{"SAM_DNS_RATE_TRACKED_PREFIXES": "2", "SAM_DNS_RATE_BURST": "1", "SAM_DNS_RATE_LIMIT": "1"})
	l := NewRateLimiter(cfg)
	now := time.Unix(1_800_000_000, 0)
	l.now = func() time.Time { return now }
	l.Allow(net.IPv4(10, 0, 0, 1))
	l.Allow(net.IPv4(10, 0, 1, 1))
	now = now.Add(5 * time.Second) // both buckets refilled: idle, evictable
	if v := l.Allow(net.IPv4(10, 0, 2, 1)); v != rateAllow {
		t.Fatalf("new prefix after eviction: %v", v)
	}
	if l.overflow != nil {
		t.Fatal("used the overflow bucket although idle buckets could be evicted")
	}
}
