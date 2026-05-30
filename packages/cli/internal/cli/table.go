package cli

import (
	"fmt"
	"io"
	"strings"
	"time"
)

// PrintTable writes an aligned text table with headers.
func PrintTable(w io.Writer, headers []string, rows [][]string) {
	widths := make([]int, len(headers))
	for i, h := range headers {
		widths[i] = len(h)
	}
	for _, row := range rows {
		for i := 0; i < len(row) && i < len(widths); i++ {
			if len(row[i]) > widths[i] {
				widths[i] = len(row[i])
			}
		}
	}

	writeRow(w, headers, widths)
	for _, row := range rows {
		writeRow(w, row, widths)
	}
}

func writeRow(w io.Writer, cells []string, widths []int) {
	for i, cell := range cells {
		if i > 0 {
			fmt.Fprint(w, "  ")
		}
		if i < len(widths) && i < len(cells)-1 {
			fmt.Fprintf(w, "%-*s", widths[i], cell)
		} else {
			fmt.Fprint(w, cell)
		}
	}
	fmt.Fprintln(w)
}

// TruncateID returns the first 7 characters of an ID for display.
func TruncateID(id string) string {
	if len(id) <= 7 {
		return id
	}
	return id[:7] + "..."
}

// FormatRelativeTime formats a timestamp string as a relative duration like "10m ago".
func FormatRelativeTime(timestamp string) string {
	if timestamp == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, timestamp)
	if err != nil {
		// Try RFC3339Nano
		t, err = time.Parse(time.RFC3339Nano, timestamp)
		if err != nil {
			return timestamp
		}
	}
	return RelativeTime(time.Since(t))
}

// RelativeTime formats a duration as a human-readable relative string.
func RelativeTime(d time.Duration) string {
	if d < 0 {
		return "just now"
	}
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		m := int(d.Minutes())
		return fmt.Sprintf("%dm ago", m)
	case d < 24*time.Hour:
		h := int(d.Hours())
		return fmt.Sprintf("%dh ago", h)
	case d < 7*24*time.Hour:
		days := int(d.Hours() / 24)
		return fmt.Sprintf("%dd ago", days)
	default:
		weeks := int(d.Hours() / 24 / 7)
		return fmt.Sprintf("%dw ago", weeks)
	}
}

// FormatSize formats a byte count as a human-readable string.
func FormatSize(bytes int64) string {
	switch {
	case bytes < 1024:
		return fmt.Sprintf("%d B", bytes)
	case bytes < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(bytes)/1024)
	default:
		return fmt.Sprintf("%.1f MB", float64(bytes)/(1024*1024))
	}
}

// derefStr safely dereferences a string pointer, returning empty string for nil.
func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// or returns fallback if value is empty.
func or(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
