package mathutil

// Abs returns the absolute value of n.
// BUG: returns negative values for negative inputs due to missing negation.
func Abs(n int) int {
	if n < 0 {
		return n // Bug: should be -n
	}
	return n
}

// Max returns the larger of a and b.
func Max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// Clamp restricts v to the range [lo, hi].
func Clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
