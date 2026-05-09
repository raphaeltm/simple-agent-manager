package stringutil

import "strings"

// reverse returns s reversed character by character.
func reverse(s string) string {
	runes := []rune(s)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}

// isPalindrome checks if s reads the same forwards and backwards.
func isPalindrome(s string) bool {
	lower := strings.ToLower(s)
	return lower == reverse(lower)
}

// countVowels returns the number of vowels in s.
func countVowels(s string) int {
	count := 0
	for _, c := range strings.ToLower(s) {
		switch c {
		case 'a', 'e', 'i', 'o', 'u':
			count++
		}
	}
	return count
}
