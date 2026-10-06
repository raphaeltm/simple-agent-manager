package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
)

const maxTableCellWidth = 120

// PrintTable writes an aligned text table with headers.
func PrintTable(w io.Writer, headers []string, rows [][]string) {
	widths := make([]int, len(headers))
	for i, h := range headers {
		headers[i] = SanitizeTableCell(h)
		widths[i] = len(headers[i])
	}
	for _, row := range rows {
		for i := 0; i < len(row) && i < len(widths); i++ {
			row[i] = SanitizeTableCell(row[i])
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

func SanitizeTableCell(value string) string {
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return ""
	}
	sanitized := strings.Join(fields, " ")
	if len(sanitized) <= maxTableCellWidth {
		return sanitized
	}
	if maxTableCellWidth <= 1 {
		return sanitized[:maxTableCellWidth]
	}
	return sanitized[:maxTableCellWidth-3] + "..."
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

// FormatAnyTimestamp handles the mixed timestamp formats used by the API:
// some fields send RFC3339 strings, others send Unix milliseconds as JSON numbers.
// encoding/json always decodes JSON numbers into float64 when the target is any.
func FormatAnyTimestamp(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return FormatRelativeTime(v)
	case float64:
		return FormatUnixTimestamp(v)
	default:
		return fmt.Sprint(v)
	}
}

func FormatUnixTimestamp(value float64) string {
	if value <= 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		return ""
	}
	seconds := int64(value)
	nanos := int64(0)
	if value > 1_000_000_000_000 {
		seconds = int64(value / 1000)
		nanos = int64(math.Mod(value, 1000)) * int64(time.Millisecond)
	}
	return RelativeTime(time.Since(time.Unix(seconds, nanos)))
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

// or returns fallback if value is empty.
func or(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func stringFromAny(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case float64:
		if v == math.Trunc(v) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	default:
		content, err := json.Marshal(v)
		if err == nil {
			return string(content)
		}
		return fmt.Sprint(v)
	}
}
