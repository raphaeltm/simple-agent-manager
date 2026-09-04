package resourcemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultMemoryPressurePath = "/proc/pressure/memory"

var ErrPressureUnavailable = errors.New("psi memory pressure unavailable")

// PressureLevel is the classified resource pressure severity.
type PressureLevel string

const (
	PressureLevelNone     PressureLevel = "none"
	PressureLevelWarning  PressureLevel = "warning"
	PressureLevelCritical PressureLevel = "critical"
)

// PSIReading is one PSI line from /proc/pressure/memory.
type PSIReading struct {
	Avg10  float64 `json:"avg10"`
	Avg60  float64 `json:"avg60"`
	Avg300 float64 `json:"avg300"`
	Total  uint64  `json:"total"`
}

// MemoryPressure is the parsed memory PSI state.
type MemoryPressure struct {
	Available   bool          `json:"available"`
	Some        PSIReading    `json:"some"`
	Full        PSIReading    `json:"full"`
	Level       PressureLevel `json:"level"`
	CollectedAt time.Time     `json:"collectedAt"`
}

// PSIThresholds controls warning and critical memory pressure classification.
type PSIThresholds struct {
	MemorySomeWarningThreshold  float64
	MemorySomeCriticalThreshold float64
	MemoryFullWarningThreshold  float64
	MemoryFullCriticalThreshold float64
}

// PressureMonitorConfig configures a PressureMonitor.
type PressureMonitorConfig struct {
	Path       string
	Thresholds PSIThresholds
	ReadFile   func(path string) ([]byte, error)
}

// PressureMonitor reads and classifies Linux PSI memory pressure.
type PressureMonitor struct {
	path       string
	thresholds PSIThresholds
	readFile   func(path string) ([]byte, error)

	mu     sync.RWMutex
	latest MemoryPressure
}

// NewPressureMonitor creates a PSI memory pressure monitor.
func NewPressureMonitor(cfg PressureMonitorConfig) *PressureMonitor {
	if cfg.Path == "" {
		cfg.Path = defaultMemoryPressurePath
	}
	if cfg.ReadFile == nil {
		cfg.ReadFile = os.ReadFile
	}
	return &PressureMonitor{
		path:       cfg.Path,
		thresholds: cfg.Thresholds,
		readFile:   cfg.ReadFile,
		latest: MemoryPressure{
			Available: false,
			Level:     PressureLevelNone,
		},
	}
}

// Poll reads the configured PSI file and updates the monitor's latest state.
func (m *PressureMonitor) Poll(ctx context.Context) (MemoryPressure, error) {
	if ctx != nil {
		select {
		case <-ctx.Done():
			return MemoryPressure{}, ctx.Err()
		default:
		}
	}

	data, err := m.readFile(m.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			m.setUnavailable()
			return m.Latest(), ErrPressureUnavailable
		}
		return MemoryPressure{}, fmt.Errorf("read memory pressure: %w", err)
	}

	pressure, err := ParseMemoryPressure(string(data))
	if err != nil {
		return MemoryPressure{}, err
	}
	pressure.Available = true
	pressure.CollectedAt = time.Now().UTC()
	pressure.Level = ClassifyMemoryPressure(pressure, m.thresholds)

	m.mu.Lock()
	m.latest = pressure
	m.mu.Unlock()

	return pressure, nil
}

// PressureLevel returns the latest classified pressure level.
func (m *PressureMonitor) PressureLevel() PressureLevel {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.latest.Level
}

// Latest returns the latest PSI memory pressure snapshot.
func (m *PressureMonitor) Latest() MemoryPressure {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.latest
}

func (m *PressureMonitor) setUnavailable() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.latest = MemoryPressure{
		Available:   false,
		Level:       PressureLevelNone,
		CollectedAt: time.Now().UTC(),
	}
}

// ParseMemoryPressure parses /proc/pressure/memory content.
func ParseMemoryPressure(content string) (MemoryPressure, error) {
	var pressure MemoryPressure
	var sawSome, sawFull bool

	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		name, reading, err := parsePSILine(line)
		if err != nil {
			return MemoryPressure{}, err
		}
		switch name {
		case "some":
			pressure.Some = reading
			sawSome = true
		case "full":
			pressure.Full = reading
			sawFull = true
		}
	}

	if !sawSome || !sawFull {
		return MemoryPressure{}, fmt.Errorf("parse memory pressure: missing required some/full lines")
	}
	pressure.Available = true
	pressure.Level = PressureLevelNone
	return pressure, nil
}

func parsePSILine(line string) (string, PSIReading, error) {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return "", PSIReading{}, fmt.Errorf("parse psi line: expected fields in %q", line)
	}
	name := fields[0]
	if name != "some" && name != "full" {
		return name, PSIReading{}, nil
	}

	var reading PSIReading
	for _, field := range fields[1:] {
		key, value, ok := strings.Cut(field, "=")
		if !ok {
			continue
		}
		switch key {
		case "avg10":
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil {
				return "", PSIReading{}, fmt.Errorf("parse psi avg10: %w", err)
			}
			reading.Avg10 = parsed
		case "avg60":
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil {
				return "", PSIReading{}, fmt.Errorf("parse psi avg60: %w", err)
			}
			reading.Avg60 = parsed
		case "avg300":
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil {
				return "", PSIReading{}, fmt.Errorf("parse psi avg300: %w", err)
			}
			reading.Avg300 = parsed
		case "total":
			parsed, err := strconv.ParseUint(value, 10, 64)
			if err != nil {
				return "", PSIReading{}, fmt.Errorf("parse psi total: %w", err)
			}
			reading.Total = parsed
		}
	}

	return name, reading, nil
}

// ClassifyMemoryPressure returns none, warning, or critical for the parsed PSI state.
func ClassifyMemoryPressure(pressure MemoryPressure, thresholds PSIThresholds) PressureLevel {
	some := maxPressureWindow(pressure.Some)
	full := maxPressureWindow(pressure.Full)

	if some >= thresholds.MemorySomeCriticalThreshold || full >= thresholds.MemoryFullCriticalThreshold {
		return PressureLevelCritical
	}
	if some >= thresholds.MemorySomeWarningThreshold || full >= thresholds.MemoryFullWarningThreshold {
		return PressureLevelWarning
	}
	return PressureLevelNone
}

func maxPressureWindow(reading PSIReading) float64 {
	if reading.Avg10 >= reading.Avg60 {
		return reading.Avg10
	}
	return reading.Avg60
}
