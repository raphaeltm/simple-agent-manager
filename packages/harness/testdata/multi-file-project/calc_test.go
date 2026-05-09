package calc

import "testing"

func TestComputeSum(t *testing.T) {
	got := ComputeSum(3, 4)
	if got != 7 {
		t.Errorf("ComputeSum(3, 4) = %d, want 7", got)
	}
}

func TestFormatSum(t *testing.T) {
	got := FormatSum(3, 4)
	want := "3 + 4 = 7"
	if got != want {
		t.Errorf("FormatSum(3, 4) = %q, want %q", got, want)
	}
}
