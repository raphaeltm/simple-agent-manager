package stringutil

import "testing"

func TestReverse(t *testing.T) {
	tests := []struct {
		input, want string
	}{
		{"hello", "olleh"},
		{"", ""},
		{"a", "a"},
	}
	for _, tt := range tests {
		got := reverse(tt.input)
		if got != tt.want {
			t.Errorf("reverse(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestIsPalindrome(t *testing.T) {
	if !isPalindrome("Racecar") {
		t.Error("Racecar should be a palindrome")
	}
	if isPalindrome("hello") {
		t.Error("hello should not be a palindrome")
	}
}

func TestCountVowels(t *testing.T) {
	got := countVowels("hello world")
	if got != 3 {
		t.Errorf("countVowels(\"hello world\") = %d, want 3", got)
	}
}
