package mathutil

import "testing"

func TestAbs(t *testing.T) {
	tests := []struct {
		input, want int
	}{
		{5, 5},
		{0, 0},
		{-3, 3},
		{-100, 100},
	}
	for _, tt := range tests {
		got := Abs(tt.input)
		if got != tt.want {
			t.Errorf("Abs(%d) = %d, want %d", tt.input, got, tt.want)
		}
	}
}

func TestMax(t *testing.T) {
	if Max(3, 5) != 5 {
		t.Error("Max(3, 5) should be 5")
	}
}
