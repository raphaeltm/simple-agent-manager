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

// parseAddress parses "XXXXXXXX:XXXX" into IP string and port int.
// The IP is in little-endian hex format (network byte order reversed per 32-bit word).
func parseAddress(s string) (string, int, error) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return "", 0, fmt.Errorf("invalid address format: %s", s)
	}

	ip, err := hexToIPv4(parts[0])
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
