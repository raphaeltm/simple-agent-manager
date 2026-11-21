package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/miekg/dns"
)

// fakeGateway serves the Worker's dns-records contract from an in-memory record list, paging by
// name, and lets a test bump the serial between pages.
type fakeGateway struct {
	mu          sync.Mutex
	serial      int64
	records     []SyncedRecord
	requests    int
	afterPage   func(g *fakeGateway, pageIndex int) // called after serving a page (locked)
	pageIndex   int
	wrongSecret bool
}

func (g *fakeGateway) handler(t *testing.T, secret string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		defer g.mu.Unlock()
		g.requests++
		if r.Header.Get(headerGatewaySecret) != secret {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Header.Get("X-Forwarded-Host") != "api.box.example.test" {
			t.Errorf("X-Forwarded-Host %q", r.Header.Get("X-Forwarded-Host"))
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		after := r.URL.Query().Get("after")
		if known := r.URL.Query().Get("serial"); known != "" && after == "" && known == strconv.FormatInt(g.serial, 10) {
			_ = json.NewEncoder(w).Encode(map[string]any{"serial": g.serial, "unchanged": true})
			return
		}
		sorted := append([]SyncedRecord(nil), g.records...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
		start := 0
		if after != "" {
			name := strings.SplitN(after, "|", 2)[0]
			start = sort.Search(len(sorted), func(i int) bool { return sorted[i].Name > name })
		}
		end := start + limit
		var next *string
		if end < len(sorted) {
			c := sorted[end-1].Name + "|A"
			next = &c
		} else {
			end = len(sorted)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"serial": g.serial, "records": sorted[start:end], "nextCursor": next, "skipped": 0})
		if g.afterPage != nil {
			g.afterPage(g, g.pageIndex)
		}
		g.pageIndex++
	})
}

func routes(n int) []SyncedRecord {
	out := make([]SyncedRecord, n)
	for i := range out {
		out[i] = SyncedRecord{Name: fmt.Sprintf("r%d-web-80-env1.apps.box.example.test", i), Type: "A", Content: fmt.Sprintf("198.51.100.%d", i%250+1)}
	}
	return out
}

func syncerFor(t *testing.T, g *fakeGateway, overrides map[string]string) (*Syncer, *atomic.Pointer[Zone], *Config) {
	t.Helper()
	cfg := testConfig(t, overrides)
	srv := httptest.NewServer(g.handler(t, cfg.GatewaySecret))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL + "/api/self-host/gateway/dns-records")
	cfg.GatewayURL = u
	var zone atomic.Pointer[Zone]
	z, _ := BuildZone(cfg, 0, nil)
	zone.Store(z)
	return NewSyncer(cfg, &zone), &zone, cfg
}

func TestSyncReadsMoreThanOnePage(t *testing.T) {
	// 2 * page + 3 records (rule 81: more than any count in the path).
	g := &fakeGateway{serial: 41, records: routes(2*7 + 3)}
	s, zone, _ := syncerFor(t, g, map[string]string{"SAM_DNS_SYNC_PAGE_SIZE": "7"})
	if err := s.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	z := zone.Load()
	for _, r := range g.records {
		got := z.Lookup(dns.Fqdn(r.Name), dns.TypeA, nil)
		if len(got.Answer) != 1 || got.Answer[0].(*dns.A).A.String() != r.Content {
			t.Fatalf("%s not served after sync: %v", r.Name, got.Answer)
		}
	}
	if z.serial != 41 {
		t.Fatalf("serial %d", z.serial)
	}
	// An unchanged serial costs one request and keeps the zone.
	before := g.requests
	if err := s.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if g.requests-before != 1 || zone.Load() != z {
		t.Fatalf("unchanged sync made %d requests or swapped the zone", g.requests-before)
	}
}

func TestSyncRestartsWhenTheSerialMovesBetweenPages(t *testing.T) {
	g := &fakeGateway{serial: 5, records: routes(10)}
	g.afterPage = func(g *fakeGateway, i int) {
		if i == 0 { // a release lands while the sidecar reads page 1
			g.serial = 6
			g.records = append(g.records, SyncedRecord{Name: "late.apps.box.example.test", Type: "A", Content: "192.0.2.77"})
		}
	}
	s, zone, _ := syncerFor(t, g, map[string]string{"SAM_DNS_SYNC_PAGE_SIZE": "4"})
	if err := s.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if zone.Load().serial != 6 || len(zone.Load().Lookup("late.apps.box.example.test.", dns.TypeA, nil).Answer) != 1 {
		t.Fatal("the sync served a mix of two serials instead of starting over")
	}
}

func TestSyncFailureKeepsTheServedZoneAndCacheRestoresIt(t *testing.T) {
	g := &fakeGateway{serial: 9, records: routes(3)}
	cache := filepath.Join(t.TempDir(), "zone.json")
	s, zone, cfg := syncerFor(t, g, map[string]string{"SAM_DNS_CACHE_FILE": cache})
	if err := s.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	served := zone.Load()
	g.mu.Lock()
	g.serial = 10
	g.mu.Unlock()
	s.cfg.GatewaySecret = strings.Repeat("x", 64) // the gateway now refuses us
	if err := s.SyncOnce(context.Background()); err == nil {
		t.Fatal("a refused sync reported success")
	}
	if zone.Load() != served {
		t.Fatal("a failed sync replaced the served zone")
	}

	// A restart while celld is down serves the cached zone.
	var restored atomic.Pointer[Zone]
	empty, _ := BuildZone(cfg, 0, nil)
	restored.Store(empty)
	NewSyncer(cfg, &restored).LoadCache()
	if got := restored.Load().Lookup("r0-web-80-env1.apps.box.example.test.", dns.TypeA, nil); len(got.Answer) != 1 {
		t.Fatalf("cached zone not restored: %v", got)
	}
}
