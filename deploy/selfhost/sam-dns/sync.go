package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"
)

// Header and response of the Worker's gateway route (apps/api/src/selfhost/dns/gateway-route.ts).
// Keep the two in step.
const headerGatewaySecret = "X-SAM-Gateway-Secret"

// maxPageBytes bounds one page read: 1000 records of at most ~300 bytes, with room to spare.
const maxPageBytes = 2 << 20

type gatewayPage struct {
	Serial     int64          `json:"serial"`
	Unchanged  bool           `json:"unchanged"`
	Records    []SyncedRecord `json:"records"`
	NextCursor *string        `json:"nextCursor"`
	Skipped    int            `json:"skipped"`
}

// errSerialMoved: a write landed between two pages; the read starts over.
var errSerialMoved = errors.New("zone serial changed during the read")

// Syncer keeps the served zone in step with D1. It polls; it never runs per query.
type Syncer struct {
	cfg    *Config
	zone   *atomic.Pointer[Zone]
	client *http.Client
	serial int64 // the D1 serial of the served zone
	synced bool  // false until the first successful sync (a cached zone does not count)
}

func NewSyncer(cfg *Config, zone *atomic.Pointer[Zone]) *Syncer {
	return &Syncer{cfg: cfg, zone: zone, client: &http.Client{
		Timeout: cfg.GatewayTimeout,
		// Never follow a redirect off the loopback gateway with the secret attached.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func (s *Syncer) page(ctx context.Context, serial int64, after string) (*gatewayPage, error) {
	q := url.Values{"limit": {strconv.Itoa(s.cfg.SyncPageSize)}}
	if serial > 0 && after == "" && s.synced {
		q.Set("serial", strconv.FormatInt(serial, 10))
	}
	if after != "" {
		q.Set("after", after)
	}
	u := *s.cfg.GatewayURL
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	// celld builds request.url from X-Forwarded-Host (CELLD_TRUST_FORWARDED_HEADERS=1): name the
	// API host so the request reaches the gateway router, as sam-mx does.
	req.Host = s.cfg.APIHost
	req.Header.Set("X-Forwarded-Host", s.cfg.APIHost)
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set(headerGatewaySecret, s.cfg.GatewaySecret)
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxPageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxPageBytes {
		return nil, fmt.Errorf("gateway page larger than %d bytes", maxPageBytes)
	}
	if resp.StatusCode != http.StatusOK {
		// 404: the box zone is off (SAM_DNS_PROVIDER is not "box") or no gateway secret is set.
		return nil, fmt.Errorf("gateway answered HTTP %d", resp.StatusCode)
	}
	var page gatewayPage
	if err := json.Unmarshal(body, &page); err != nil {
		return nil, fmt.Errorf("gateway page is not JSON: %w", err)
	}
	if page.Serial <= 0 || page.Serial > math.MaxUint32 {
		return nil, fmt.Errorf("gateway serial %d is out of range", page.Serial)
	}
	return &page, nil
}

// readZone reads every page at one serial. It returns (nil, serial, nil) when the zone is
// unchanged since `known`.
func (s *Syncer) readZone(ctx context.Context, known int64) ([]SyncedRecord, int64, int, error) {
	first, err := s.page(ctx, known, "")
	if err != nil {
		return nil, 0, 0, err
	}
	if first.Unchanged {
		return nil, first.Serial, 0, nil
	}
	records := append([]SyncedRecord(nil), first.Records...)
	skipped := first.Skipped
	for next := first.NextCursor; next != nil && *next != ""; {
		previous := *next
		p, err := s.page(ctx, 0, previous)
		if err != nil {
			return nil, 0, 0, err
		}
		if p.Serial != first.Serial {
			return nil, 0, 0, errSerialMoved
		}
		records = append(records, p.Records...)
		skipped += p.Skipped
		next = p.NextCursor
		if next != nil && *next == previous {
			return nil, 0, 0, fmt.Errorf("gateway cursor did not advance")
		}
	}
	return records, first.Serial, skipped, nil
}

// SyncOnce brings the served zone up to date. The whole read is bounded by SyncDeadline (time,
// not page count); a serial that moves mid-read restarts it within the same deadline. On any
// failure the zone being served is kept.
func (s *Syncer) SyncOnce(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, s.cfg.SyncDeadline)
	defer cancel()
	for {
		records, serial, skipped, err := s.readZone(ctx, s.serial)
		if errors.Is(err, errSerialMoved) {
			select { // a short pause, so constant churn does not spin requests
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(100 * time.Millisecond):
			}
			continue
		}
		if err != nil {
			return err
		}
		if s.synced && records == nil && serial == s.serial {
			return nil
		}
		zone, invalid := BuildZone(s.cfg, uint32(serial), records)
		s.zone.Store(zone)
		s.serial = serial
		s.synced = true
		slog.Info("sam-dns: zone synced", "serial", serial, "records", len(records),
			"skippedByWorker", skipped, "skippedHere", invalid)
		if s.cfg.CacheFile != "" {
			if err := writeCache(s.cfg.CacheFile, serial, records); err != nil {
				slog.Warn("sam-dns: zone cache not written", "error", err.Error())
			}
		}
		return nil
	}
}

// Run syncs every SyncInterval until ctx ends.
func (s *Syncer) Run(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.SyncInterval)
	defer ticker.Stop()
	failing := false
	for {
		if err := s.SyncOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return // shutting down
			}
			if !failing { // log the transition, not every tick
				slog.Error("sam-dns: zone sync failed; serving the last good zone",
					"servedSerial", s.serial, "error", err.Error())
			}
			failing = true
		} else if failing {
			slog.Info("sam-dns: zone sync recovered", "serial", s.serial)
			failing = false
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

type zoneCache struct {
	Serial  int64          `json:"serial"`
	Records []SyncedRecord `json:"records"`
}

// writeCache keeps the last good zone on disk (atomic replace, mode 0600) so a box that restarts
// while celld is down still answers for its app routes.
func writeCache(path string, serial int64, records []SyncedRecord) error {
	data, err := json.Marshal(zoneCache{Serial: serial, Records: records})
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".zone-cache-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil { // the rename must not publish an empty file after a crash
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// LoadCache restores the zone written by writeCache, if any.
func (s *Syncer) LoadCache() {
	if s.cfg.CacheFile == "" {
		return
	}
	data, err := os.ReadFile(s.cfg.CacheFile)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			slog.Warn("sam-dns: zone cache unreadable", "error", err.Error())
		}
		return
	}
	var cached zoneCache
	if err := json.Unmarshal(data, &cached); err != nil {
		slog.Warn("sam-dns: zone cache is not valid JSON; ignored", "error", err.Error())
		return
	}
	zone, invalid := BuildZone(s.cfg, uint32(cached.Serial), cached.Records)
	s.zone.Store(zone)
	// Not s.serial: the first sync must still read the live zone in full.
	slog.Info("sam-dns: serving cached zone until the first sync", "serial", cached.Serial,
		"records", len(cached.Records), "skipped", invalid)
}
