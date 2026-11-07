package acp

import "strings"

// codexTOMLStatementStarts reports, for each line, whether it begins a TOML statement
// (a key/value pair, a table header, a comment or a blank line) rather than continuing
// a multi-line string or a multi-line array opened on an earlier line. The Codex
// config merge splices text line by line, and a line inside such a value can look
// like a table header ("[features]", "[1, 2],") without being one.
func codexTOMLStatementStarts(lines []string) []bool {
	starts := make([]bool, len(lines))
	var s codexTOMLScanState
	for i, line := range lines {
		starts[i] = s.atStatementBoundary()
		if starts[i] && strings.HasPrefix(strings.TrimSpace(line), "[") {
			// A table header cannot open a multi-line value.
			continue
		}
		s.scanLine(line)
	}
	return starts
}

type codexTOMLScanState struct {
	multiLineQuote string // `"""` or `'''` while inside a multi-line string
	depth          int    // open [ and { in a value
}

func (s *codexTOMLScanState) atStatementBoundary() bool {
	return s.multiLineQuote == "" && s.depth == 0
}

func (s *codexTOMLScanState) scanLine(line string) {
	for i := 0; i < len(line); {
		if s.multiLineQuote != "" {
			if s.multiLineQuote == `"""` && line[i] == '\\' {
				i += 2
				continue
			}
			if strings.HasPrefix(line[i:], s.multiLineQuote) {
				s.multiLineQuote = ""
				i += 3
				continue
			}
			i++
			continue
		}
		switch c := line[i]; {
		case c == '#':
			return
		case strings.HasPrefix(line[i:], `"""`), strings.HasPrefix(line[i:], `'''`):
			s.multiLineQuote = line[i : i+3]
			i += 3
		case c == '"' || c == '\'':
			i = skipCodexTOMLSingleLineString(line, i)
		case c == '[' || c == '{':
			s.depth++
			i++
		case c == ']' || c == '}':
			if s.depth > 0 {
				s.depth--
			}
			i++
		default:
			i++
		}
	}
}

// skipCodexTOMLSingleLineString returns the index just past the basic or literal
// string that opens at line[start].
func skipCodexTOMLSingleLineString(line string, start int) int {
	quote := line[start]
	for i := start + 1; i < len(line); i++ {
		switch {
		case quote == '"' && line[i] == '\\':
			i++
		case line[i] == quote:
			return i + 1
		}
	}
	return len(line)
}

// codexTOMLStatementText returns the full text of the statement starting at line i,
// including any continuation lines of a multi-line value.
func codexTOMLStatementText(lines []string, starts []bool, i int) string {
	end := i + 1
	for end < len(lines) && !starts[end] {
		end++
	}
	return strings.Join(lines[i:end], "\n")
}

// codexTOMLFirstTableLine returns the index of the first table header, or len(lines).
func codexTOMLFirstTableLine(lines []string, starts []bool) int {
	for i, line := range lines {
		if starts[i] && strings.HasPrefix(strings.TrimSpace(line), "[") {
			return i
		}
	}
	return len(lines)
}
