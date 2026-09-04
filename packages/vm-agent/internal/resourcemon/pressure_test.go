package resourcemon

import (
	"context"
	"errors"
	"os"
	"testing"
)

func testPSIThresholds() PSIThresholds {
	return PSIThresholds{
		MemorySomeWarningThreshold:  25,
		MemorySomeCriticalThreshold: 50,
		MemoryFullWarningThreshold:  10,
		MemoryFullCriticalThreshold: 25,
	}
}

func TestParseMemoryPressure(t *testing.T) {
	input := `some avg10=12.34 avg60=5.67 avg300=1.23 total=456789
full avg10=0.50 avg60=0.25 avg300=0.10 total=12345
`
	pressure, err := ParseMemoryPressure(input)
	if err != nil {
		t.Fatalf("ParseMemoryPressure() error = %v", err)
	}
	if !pressure.Available {
		t.Fatal("pressure should be available")
	}
	if pressure.Some.Avg10 != 12.34 || pressure.Some.Avg60 != 5.67 || pressure.Some.Avg300 != 1.23 || pressure.Some.Total != 456789 {
		t.Fatalf("unexpected some pressure: %#v", pressure.Some)
	}
	if pressure.Full.Avg10 != 0.50 || pressure.Full.Avg60 != 0.25 || pressure.Full.Avg300 != 0.10 || pressure.Full.Total != 12345 {
		t.Fatalf("unexpected full pressure: %#v", pressure.Full)
	}
}

func TestClassifyMemoryPressure(t *testing.T) {
	thresholds := testPSIThresholds()
	tests := []struct {
		name     string
		pressure MemoryPressure
		want     PressureLevel
	}{
		{
			name: "none below thresholds",
			pressure: MemoryPressure{
				Some: PSIReading{Avg10: 1, Avg60: 2},
				Full: PSIReading{Avg10: 1, Avg60: 2},
			},
			want: PressureLevelNone,
		},
		{
			name: "some avg10 warning",
			pressure: MemoryPressure{
				Some: PSIReading{Avg10: 25, Avg60: 2},
				Full: PSIReading{Avg10: 1, Avg60: 2},
			},
			want: PressureLevelWarning,
		},
		{
			name: "some avg60 critical",
			pressure: MemoryPressure{
				Some: PSIReading{Avg10: 1, Avg60: 50},
				Full: PSIReading{Avg10: 1, Avg60: 2},
			},
			want: PressureLevelCritical,
		},
		{
			name: "full avg10 warning",
			pressure: MemoryPressure{
				Some: PSIReading{Avg10: 1, Avg60: 2},
				Full: PSIReading{Avg10: 10, Avg60: 2},
			},
			want: PressureLevelWarning,
		},
		{
			name: "full avg60 critical",
			pressure: MemoryPressure{
				Some: PSIReading{Avg10: 1, Avg60: 2},
				Full: PSIReading{Avg10: 1, Avg60: 25},
			},
			want: PressureLevelCritical,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ClassifyMemoryPressure(test.pressure, thresholds); got != test.want {
				t.Fatalf("ClassifyMemoryPressure() = %s, want %s", got, test.want)
			}
		})
	}
}

func TestPressureMonitorUnavailableGraceful(t *testing.T) {
	monitor := NewPressureMonitor(PressureMonitorConfig{
		Path:       "/missing/pressure",
		Thresholds: testPSIThresholds(),
		ReadFile: func(path string) ([]byte, error) {
			return nil, os.ErrNotExist
		},
	})

	pressure, err := monitor.Poll(context.Background())
	if !errors.Is(err, ErrPressureUnavailable) {
		t.Fatalf("Poll() error = %v, want ErrPressureUnavailable", err)
	}
	if pressure.Available {
		t.Fatal("pressure should not be available when PSI file is missing")
	}
	if pressure.Level != PressureLevelNone {
		t.Fatalf("pressure level = %s, want none", pressure.Level)
	}
	if monitor.PressureLevel() != PressureLevelNone {
		t.Fatalf("PressureLevel() = %s, want none", monitor.PressureLevel())
	}
}
