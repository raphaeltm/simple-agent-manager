package main

import (
	"net"
	"testing"
)

func TestMPTCPDisabledByDefault(t *testing.T) {
	// Test the compiled default, independent of the caller's runtime overrides.
	t.Setenv("GODEBUG", "")
	var config net.ListenConfig
	if config.MultipathTCP() {
		t.Fatal("VM agent listeners must disable MPTCP by default (CVE-2026-98432)")
	}
}
