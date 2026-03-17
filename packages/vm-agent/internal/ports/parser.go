// Package ports provides container port detection via /proc/net/tcp parsing.
package ports

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
)

// TCPEntry represents a parsed line from /proc/net/tcp.
type TCPEntry struct {
	LocalAddress string // e.g., "0.0.0.0" or "127.0.0.1"
	LocalPort    int    // e.g., 3000
	State        int    // TCP state (10 = LISTEN)
}

// StateListen is the TCP state for LISTEN sockets.
const StateListen = 10 // 0x0A

// ParseProcNetTCP parses the contents of /proc/net/tcp and returns all entries.
// The format is documented in the Linux kernel source (net/ipv4/tcp_ipv4.c).
// Each line after the header looks like:
//
//	sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
//	0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345
func ParseProcNetTCP(content string) ([]TCPEntry, error) {
	var entries []TCPEntry
	scanner := bufio.NewScanner(strings.NewReader(content))

	// Skip header line
	if !scanner.Scan() {
		return entries, nil
	}

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		entry, err := parseLine(line)
		if err != nil {
			// Skip malformed lines rather than failing the entire parse
			continue
		}
		entries = append(entries, entry)
	}

	return entries, scanner.Err()
}

// FilterListening returns only entries in LISTEN state, excluding ports in the
// exclude set and ports >= ephemeralMin.
func FilterListening(entries []TCPEntry, excludePorts map[int]bool, ephemeralMin int) []TCPEntry {
	var result []TCPEntry
	for _, e := range entries {
		if e.State != StateListen {
			continue
		}
		if excludePorts[e.LocalPort] {
			continue
		}
		if ephemeralMin > 0 && e.LocalPort >= ephemeralMin {
			continue
		}
		result = append(result, e)
	}
	return result
}

func parseLine(line string) (TCPEntry, error) {
	// Fields are separated by whitespace. We need fields at index 1 (local_address) and 3 (state).
	fields := strings.Fields(line)
	if len(fields) < 4 {
		return TCPEntry{}, fmt.Errorf("too few fields: %d", len(fields))
	}

	// Parse local address (hex IP:hex port)
	addr, port, err := parseAddress(fields[1])
	if err != nil {
		return TCPEntry{}, fmt.Errorf("parse local address: %w", err)
	}

	// Parse state (hex)
	state, err := strconv.ParseInt(fields[3], 16, 32)
	if err != nil {
		return TCPEntry{}, fmt.Errorf("parse state: %w", err)
	}

	return TCPEntry{
		LocalAddress: addr,
		LocalPort:    port,
		State:        int(state),
	}, nil
}

// parseAddress parses "XXXXXXXX:XXXX" (IPv4) or "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX:XXXX" (IPv6)
// into an IP string and port int.
// The IP is in little-endian hex format (network byte order reversed per 32-bit word).
func parseAddress(s string) (string, int, error) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return "", 0, fmt.Errorf("invalid address format: %s", s)
	}

	var ip string
	var err error
	switch len(parts[0]) {
	case 8:
		ip, err = hexToIPv4(parts[0])
	case 32:
		ip, err = hexToIPv6(parts[0])
	default:
		err = fmt.Errorf("unexpected address hex length: %d", len(parts[0]))
	}
	if err != nil {
		return "", 0, err
	}

	port, err := strconv.ParseInt(parts[1], 16, 32)
	if err != nil {
		return "", 0, fmt.Errorf("invalid port hex: %s", parts[1])
	}

	return ip, int(port), nil
}

// hexToIPv4 converts an 8-character hex string to a dotted IPv4 address.
// /proc/net/tcp stores IPv4 addresses in little-endian (host byte order on x86).
func hexToIPv4(hexStr string) (string, error) {
	if len(hexStr) != 8 {
		return "", fmt.Errorf("expected 8 hex chars, got %d", len(hexStr))
	}

	bytes, err := hex.DecodeString(hexStr)
	if err != nil {
		return "", fmt.Errorf("decode hex: %w", err)
	}

	// Little-endian: bytes are reversed
	return fmt.Sprintf("%d.%d.%d.%d", bytes[3], bytes[2], bytes[1], bytes[0]), nil
}

// hexToIPv6 converts a 32-character hex string to a simplified IPv6 address string.
// /proc/net/tcp6 stores IPv6 addresses as four 32-bit words in little-endian order.
// For port scanning purposes, we return "::" for all-zeros and "::1" for loopback,
// and the full address otherwise.
func hexToIPv6(hexStr string) (string, error) {
	if len(hexStr) != 32 {
		return "", fmt.Errorf("expected 32 hex chars, got %d", len(hexStr))
	}

	b, err := hex.DecodeString(hexStr)
	if err != nil {
		return "", fmt.Errorf("decode hex: %w", err)
	}

	// Each 4-byte group is little-endian. Reverse within each group.
	// /proc/net/tcp6 format: 4 groups of 4 bytes, each group in host byte order.
	allZero := true
	for _, v := range b {
		if v != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		return "::", nil
	}

	// Check for ::1 (loopback) — all zeros except last byte is 1
	isLoopback := b[15] == 0 && b[14] == 0 && b[13] == 0 && b[12] == 1
	if isLoopback {
		for i := 0; i < 12; i++ {
			if b[i] != 0 {
				isLoopback = false
				break
			}
		}
	}
	if isLoopback {
		return "::1", nil
	}

	// General case: build colon-separated hex notation.
	// Reverse each 4-byte word from little-endian to network order.
	var groups [8]uint16
	for i := 0; i < 4; i++ {
		off := i * 4
		// Little-endian 32-bit word → bytes[off+3] is MSB
		groups[i*2] = uint16(b[off+1])<<8 | uint16(b[off+0])
		groups[i*2+1] = uint16(b[off+3])<<8 | uint16(b[off+2])
	}

	parts := make([]string, 8)
	for i, g := range groups {
		parts[i] = fmt.Sprintf("%x", g)
	}
	return strings.Join(parts, ":"), nil
}
