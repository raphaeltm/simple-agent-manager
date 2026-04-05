package browser

import (
	"fmt"
	"net"
	"strings"
)

// DetectPublicIP returns the first non-loopback, non-link-local IPv4 address.
// This is used for NEKO_NAT1TO1 to advertise the VM's public IP to WebRTC peers.
func DetectPublicIP() (string, error) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "", fmt.Errorf("failed to get network interfaces: %w", err)
	}

	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipNet.IP
		if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			continue
		}
		// Prefer IPv4
		if ip4 := ip.To4(); ip4 != nil {
			ipStr := ip4.String()
			// Skip Docker bridge IPs (172.17.x.x, 172.18.x.x, etc.)
			if strings.HasPrefix(ipStr, "172.") {
				continue
			}
			// Skip common private ranges that are likely Docker/internal
			if strings.HasPrefix(ipStr, "10.") {
				continue
			}
			return ipStr, nil
		}
	}

	return "", fmt.Errorf("no suitable public IPv4 address found")
}
