package main

import (
	"fmt"
	"net"
	"net/textproto"
	"strings"
	"testing"
	"time"
)

func protocolClient(t *testing.T, h *harness) *textproto.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", h.addr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	c := textproto.NewConn(conn)
	if _, _, err := c.ReadResponse(220); err != nil {
		t.Fatal(err)
	}
	protocolCommand(t, c, "EHLO client.example", 250)
	return c
}

func protocolCommand(t *testing.T, c *textproto.Conn, command string, want int) {
	t.Helper()
	if err := c.PrintfLine("%s", command); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.ReadResponse(want); err != nil {
		t.Fatalf("command %.40q: %v", command, err)
	}
}

func TestRejectedBDATDiscardsChunkBeforeNextCommand(t *testing.T) {
	h := newHarness(t, nil)
	c := protocolClient(t, h)
	// A chunk still follows a rejected BDAT. Its bytes must never become commands.
	protocolCommand(t, c, "BDAT 6 LAST\r\nQUIT", 502)
	protocolCommand(t, c, "NOOP", 250)
	if h.gateway.count() != 0 {
		t.Fatal("rejected chunk reached the gateway")
	}
}

func TestBDATRestoresCommandLineLimitBetweenChunks(t *testing.T) {
	h := newHarness(t, nil)
	c := protocolClient(t, h)
	protocolCommand(t, c, "MAIL FROM:<"+allowedFrom+">", 250)
	protocolCommand(t, c, "RCPT TO:<"+agentRcpt+">", 250)
	protocolCommand(t, c, "BDAT 2\r\n", 250)
	// The chunk temporarily disables the line limit, but the next command is bounded.
	protocolCommand(t, c, "NOOP "+strings.Repeat("x", DefaultMaxLineLength), 500)
	if h.gateway.count() != 0 {
		t.Fatal("unfinished message reached the gateway")
	}
}

func TestPostmasterStillCannotRelay(t *testing.T) {
	h := newHarness(t, nil)
	c := protocolClient(t, h)
	protocolCommand(t, c, "MAIL FROM:<"+allowedFrom+">", 250)
	// v0.26 parses this RFC form; SAM must still reject it at its recipient boundary.
	protocolCommand(t, c, "RCPT TO:<Postmaster>", 550)
	protocolCommand(t, c, "RCPT TO:<"+agentRcpt+">", 250)
	if h.gateway.count() != 0 {
		t.Fatal("recipient-only commands reached the gateway")
	}
}

func TestBDATDeliversConsecutiveTransactions(t *testing.T) {
	h := newHarness(t, nil)
	c := protocolClient(t, h)
	for i := 0; i < 2; i++ {
		protocolCommand(t, c, "MAIL FROM:<"+allowedFrom+">", 250)
		protocolCommand(t, c, "RCPT TO:<"+agentRcpt+">", 250)
		raw := h.sign("sender.example", message(allowedFrom, fmt.Sprintf("bdat-%d", i)))
		if err := c.PrintfLine("BDAT %d LAST", len(raw)); err != nil {
			t.Fatal(err)
		}
		if _, err := c.W.Write(raw); err != nil {
			t.Fatal(err)
		}
		if err := c.W.Flush(); err != nil {
			t.Fatal(err)
		}
		if _, _, err := c.ReadResponse(250); err != nil {
			t.Fatal(err)
		}
		if h.gateway.count() != i+1 {
			t.Fatalf("transaction %d: gateway count = %d", i, h.gateway.count())
		}
		h.gateway.mu.Lock()
		call := h.gateway.calls[i]
		h.gateway.mu.Unlock()
		if string(call.body) != string(raw) || call.header.Get(headerMailAuthFrom) != allowedFrom || call.header.Get(headerMailAuth) != "pass" {
			t.Fatalf("transaction %d: gateway payload or authenticated sender changed", i)
		}
	}
}
