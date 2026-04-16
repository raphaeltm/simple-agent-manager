// Package resourcemon collects system resource metrics at regular intervals
// and stores them in a SQLite database. Metrics are 1-minute averages of
// CPU load, memory usage, and disk usage — useful for post-hoc debugging
// of workspace startup times and resource contention.
package resourcemon

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
)

// Snapshot is a single resource measurement.
type Snapshot struct {
	Timestamp      string  `json:"timestamp"`
	CPULoadAvg1    float64 `json:"cpuLoadAvg1"`
	CPULoadAvg5    float64 `json:"cpuLoadAvg5"`
	CPULoadAvg15   float64 `json:"cpuLoadAvg15"`
	NumCPU         int     `json:"numCpu"`
	MemTotalBytes  uint64  `json:"memTotalBytes"`
	MemUsedBytes   uint64  `json:"memUsedBytes"`
	MemPercent     float64 `json:"memPercent"`
	DiskTotalBytes uint64  `json:"diskTotalBytes"`
	DiskUsedBytes  uint64  `json:"diskUsedBytes"`
	DiskPercent    float64 `json:"diskPercent"`
}

// Monitor collects and stores resource metrics.
type Monitor struct {
	db     *sql.DB
	dbPath string
	cancel context.CancelFunc
	done   chan struct{}
}

// New creates a resource monitor that writes metrics to the given SQLite path.
func New(dbPath string, interval time.Duration) (*Monitor, error) {
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?cache=shared&mode=rwc&_journal_mode=WAL", dbPath))
	if err != nil {
		return nil, fmt.Errorf("resourcemon: open: %w", err)
	}
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA busy_timeout=5000",
		"PRAGMA synchronous=NORMAL",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("resourcemon: %s: %w", pragma, err)
		}
	}

	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("resourcemon: migrate: %w", err)
	}

	// Trim old data on startup (keep last 7 days).
	cutoff := time.Now().UTC().Add(-7 * 24 * time.Hour).Format(time.RFC3339)
	if _, err := db.Exec(`DELETE FROM resource_snapshots WHERE timestamp < ?`, cutoff); err != nil {
		slog.Warn("resourcemon: trim on startup failed", "error", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	m := &Monitor{db: db, dbPath: dbPath, cancel: cancel, done: make(chan struct{})}

	if interval <= 0 {
		interval = time.Minute
	}

	go m.loop(ctx, interval)
	return m, nil
}

func migrate(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS resource_snapshots (
			timestamp       TEXT PRIMARY KEY,
			cpu_load_avg1   REAL NOT NULL DEFAULT 0,
			cpu_load_avg5   REAL NOT NULL DEFAULT 0,
			cpu_load_avg15  REAL NOT NULL DEFAULT 0,
			num_cpu         INTEGER NOT NULL DEFAULT 0,
			mem_total_bytes INTEGER NOT NULL DEFAULT 0,
			mem_used_bytes  INTEGER NOT NULL DEFAULT 0,
			mem_percent     REAL NOT NULL DEFAULT 0,
			disk_total_bytes INTEGER NOT NULL DEFAULT 0,
			disk_used_bytes  INTEGER NOT NULL DEFAULT 0,
			disk_percent     REAL NOT NULL DEFAULT 0
		);
	`)
	return err
}

func (m *Monitor) loop(ctx context.Context, interval time.Duration) {
	defer close(m.done)

	// Collect immediately on start.
	m.collect()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.collect()
		}
	}
}

func (m *Monitor) collect() {
	s := collectSnapshot()
	_, err := m.db.Exec(
		`INSERT OR REPLACE INTO resource_snapshots
		 (timestamp, cpu_load_avg1, cpu_load_avg5, cpu_load_avg15, num_cpu,
		  mem_total_bytes, mem_used_bytes, mem_percent,
		  disk_total_bytes, disk_used_bytes, disk_percent)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		s.Timestamp,
		s.CPULoadAvg1, s.CPULoadAvg5, s.CPULoadAvg15, s.NumCPU,
		s.MemTotalBytes, s.MemUsedBytes, s.MemPercent,
		s.DiskTotalBytes, s.DiskUsedBytes, s.DiskPercent,
	)
	if err != nil {
		slog.Error("resourcemon: insert failed", "error", err)
	}
}

func collectSnapshot() Snapshot {
	now := time.Now().UTC().Truncate(time.Minute).Format(time.RFC3339)
	s := Snapshot{
		Timestamp: now,
		NumCPU:    runtime.NumCPU(),
	}

	// CPU load averages from /proc/loadavg
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 3 {
			s.CPULoadAvg1, _ = strconv.ParseFloat(fields[0], 64)
			s.CPULoadAvg5, _ = strconv.ParseFloat(fields[1], 64)
			s.CPULoadAvg15, _ = strconv.ParseFloat(fields[2], 64)
		}
	}

	// Memory from /proc/meminfo
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		info := parseMemInfo(string(data))
		s.MemTotalBytes = info.total
		s.MemUsedBytes = info.used
		if info.total > 0 {
			s.MemPercent = float64(info.used) / float64(info.total) * 100
		}
	}

	// Disk from statfs on /
	var stat syscall.Statfs_t
	if err := syscall.Statfs("/", &stat); err == nil {
		s.DiskTotalBytes = stat.Blocks * uint64(stat.Bsize)
		freeBytes := stat.Bavail * uint64(stat.Bsize)
		s.DiskUsedBytes = s.DiskTotalBytes - freeBytes
		if s.DiskTotalBytes > 0 {
			s.DiskPercent = float64(s.DiskUsedBytes) / float64(s.DiskTotalBytes) * 100
		}
	}

	return s
}

type memInfoResult struct {
	total uint64
	used  uint64
}

func parseMemInfo(data string) memInfoResult {
	var total, available uint64
	for _, line := range strings.Split(data, "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			total = parseMemInfoKB(line)
		} else if strings.HasPrefix(line, "MemAvailable:") {
			available = parseMemInfoKB(line)
		}
	}
	used := uint64(0)
	if total > available {
		used = total - available
	}
	return memInfoResult{total: total, used: used}
}

func parseMemInfoKB(line string) uint64 {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0
	}
	kb, _ := strconv.ParseUint(fields[1], 10, 64)
	return kb * 1024 // convert KB to bytes
}

// DBPath returns the filesystem path to the SQLite database file.
func (m *Monitor) DBPath() string {
	return m.dbPath
}

// Close stops the collection loop and closes the database.
func (m *Monitor) Close() error {
	m.cancel()
	<-m.done
	return m.db.Close()
}
