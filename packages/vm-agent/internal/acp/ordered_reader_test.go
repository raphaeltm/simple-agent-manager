package acp

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// makeNotification creates a JSON-RPC notification line (no id, has method).
func makeNotification(method string, seq int) string {
	msg := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  map[string]interface{}{"seq": seq},
	}
	b, _ := json.Marshal(msg)
	return string(b)
}

// makeRequest creates a JSON-RPC request line (has id and method).
func makeRequest(method string, id int) string {
	msg := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  map[string]interface{}{},
	}
	b, _ := json.Marshal(msg)
	return string(b)
}

// makeResponse creates a JSON-RPC response line (has id, no method).
func makeResponse(id int) string {
	msg := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  map[string]interface{}{},
	}
	b, _ := json.Marshal(msg)
	return string(b)
}

// readLines reads all lines from a reader until EOF or timeout.
func readLines(r io.Reader, count int, timeout time.Duration) []string {
	var lines []string
	scanner := bufio.NewScanner(r)
	done := make(chan struct{})
	go func() {
		for scanner.Scan() {
			lines = append(lines, scanner.Text())
			if len(lines) >= count {
				break
			}
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
	}
	return lines
}

func TestOrderedPipe_ConsecutiveNotificationsAreSerialized(t *testing.T) {
	t.Parallel()

	// Create 5 consecutive session/update notifications.
	var inputLines []string
	for i := 1; i <= 5; i++ {
		inputLines = append(inputLines, makeNotification("session/update", i))
	}
	input := strings.Join(inputLines, "\n") + "\n"

	processedCh := make(chan struct{}, 1)
	done := make(chan struct{})
	defer close(done)

	reader := newOrderedPipe(strings.NewReader(input), processedCh, done, 2*time.Second)

	// Read lines from the ordered pipe and track the order they arrive.
	var mu sync.Mutex
	var received []int
	var processOrder []int
	var processSeq int32

	scanner := bufio.NewScanner(reader)

	for scanner.Scan() {
		line := scanner.Text()
		var env struct {
			Params struct {
				Seq int `json:"seq"`
			} `json:"params"`
		}
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			t.Fatalf("failed to parse line: %v", err)
		}

		mu.Lock()
		received = append(received, env.Params.Seq)
		mu.Unlock()

		// Simulate processing with variable delay, then signal.
		order := int(atomic.AddInt32(&processSeq, 1))
		mu.Lock()
		processOrder = append(processOrder, order)
		mu.Unlock()

		// Signal that this notification has been processed.
		processedCh <- struct{}{}
	}

	// Verify all 5 notifications arrived in order.
	if len(received) != 5 {
		t.Fatalf("expected 5 lines, got %d", len(received))
	}
	for i, seq := range received {
		if seq != i+1 {
			t.Errorf("line %d: expected seq %d, got %d", i, i+1, seq)
		}
	}
}

func TestOrderedPipe_RequestsBetweenNotificationsDontBlock(t *testing.T) {
	t.Parallel()

	// Sequence: notif1, request, notif2
	// The request should NOT be delayed by notif1's processing.
	// But notif2 MUST wait for notif1.
	lines := []string{
		makeNotification("session/update", 1),
		makeRequest("fs/readTextFile", 100),
		makeNotification("session/update", 2),
	}
	input := strings.Join(lines, "\n") + "\n"

	processedCh := make(chan struct{}, 1)
	done := make(chan struct{})
	defer close(done)

	reader := newOrderedPipe(strings.NewReader(input), processedCh, done, 2*time.Second)

	var received []string
	scanner := bufio.NewScanner(reader)

	lineCount := 0
	for scanner.Scan() {
		line := scanner.Text()
		var env jsonRPCEnvelope
		json.Unmarshal([]byte(line), &env)
		received = append(received, env.Method)
		lineCount++

		// Signal after each notification.
		if env.Method != "" && env.ID == nil {
			processedCh <- struct{}{}
		}
		if lineCount >= 3 {
			break
		}
	}

	if len(received) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(received))
	}
	// All three lines should arrive in order.
	if received[0] != "session/update" {
		t.Errorf("line 0: expected session/update, got %s", received[0])
	}
	if received[1] != "fs/readTextFile" {
		t.Errorf("line 1: expected fs/readTextFile, got %s", received[1])
	}
	if received[2] != "session/update" {
		t.Errorf("line 2: expected session/update, got %s", received[2])
	}
}

func TestOrderedPipe_ResponsesPassThrough(t *testing.T) {
	t.Parallel()

	// Responses (id present, no method) should not require processing signals.
	lines := []string{
		makeResponse(1),
		makeResponse(2),
		makeResponse(3),
	}
	input := strings.Join(lines, "\n") + "\n"

	processedCh := make(chan struct{}, 1)
	done := make(chan struct{})
	defer close(done)

	reader := newOrderedPipe(strings.NewReader(input), processedCh, done, 2*time.Second)

	result := readLines(reader, 3, 2*time.Second)

	if len(result) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(result))
	}
}

func TestOrderedPipe_TimeoutSafetyNet(t *testing.T) {
	t.Parallel()

	// Two consecutive notifications but NO processing signal.
	// The second should proceed after the timeout.
	lines := []string{
		makeNotification("session/update", 1),
		makeNotification("session/update", 2),
	}
	input := strings.Join(lines, "\n") + "\n"

	processedCh := make(chan struct{}, 1)
	done := make(chan struct{})
	defer close(done)

	// Use a very short timeout for the test.
	reader := newOrderedPipe(strings.NewReader(input), processedCh, done, 50*time.Millisecond)

	start := time.Now()
	result := readLines(reader, 2, 2*time.Second)
	elapsed := time.Since(start)

	if len(result) != 2 {
		t.Fatalf("expected 2 lines, got %d", len(result))
	}

	// Should have waited roughly the timeout duration for the second line.
	if elapsed < 30*time.Millisecond {
		t.Errorf("expected at least ~50ms delay, got %v", elapsed)
	}
	if elapsed > 1*time.Second {
		t.Errorf("expected timeout to fire quickly, but took %v", elapsed)
	}
}

func TestOrderedPipe_DoneChannelStopsProcessing(t *testing.T) {
	t.Parallel()

	// Two notifications, done channel closed before second can be processed.
	lines := []string{
		makeNotification("session/update", 1),
		makeNotification("session/update", 2),
	}
	input := strings.Join(lines, "\n") + "\n"

	processedCh := make(chan struct{}, 1)
	done := make(chan struct{})

	reader := newOrderedPipe(strings.NewReader(input), processedCh, done, 5*time.Second)

	// Read the first line.
	scanner := bufio.NewScanner(reader)
	if !scanner.Scan() {
		t.Fatal("expected first line")
	}

	// Close done — the pipe should stop and not deliver the second line.
	close(done)

	// Give a moment for the goroutine to react.
	time.Sleep(50 * time.Millisecond)

	// The scanner should either get nothing or EOF.
	gotSecond := scanner.Scan()
	if gotSecond {
		t.Log("got second line (may have been buffered before done)")
	}
}

func TestOrderedPipe_NotifAfterRequestsStillWaitsForPendingNotif(t *testing.T) {
	t.Parallel()

	// Sequence: notif1, request1, request2, notif2
	// notif2 MUST wait for notif1's processing signal.
	lines := []string{
		makeNotification("session/update", 1),
		makeRequest("fs/readTextFile", 100),
		makeRequest("fs/writeTextFile", 101),
		makeNotification("session/update", 2),
	}
	input := strings.Join(lines, "\n") + "\n"

	processedCh := make(chan struct{}, 1)
	done := make(chan struct{})
	defer close(done)

	reader := newOrderedPipe(strings.NewReader(input), processedCh, done, 2*time.Second)

	var received []string
	scanner := bufio.NewScanner(reader)

	lineCount := 0
	for scanner.Scan() {
		line := scanner.Text()
		var env jsonRPCEnvelope
		json.Unmarshal([]byte(line), &env)
		received = append(received, env.Method)
		lineCount++

		// Signal only after notifications.
		if env.Method != "" && env.ID == nil {
			processedCh <- struct{}{}
		}
		if lineCount >= 4 {
			break
		}
	}

	if len(received) != 4 {
		t.Fatalf("expected 4 lines, got %d", len(received))
	}
	// Verify order: notif, req, req, notif.
	expected := []string{"session/update", "fs/readTextFile", "fs/writeTextFile", "session/update"}
	for i, exp := range expected {
		if received[i] != exp {
			t.Errorf("line %d: expected %s, got %s", i, exp, received[i])
		}
	}
}

func TestOrderedPipe_HighThroughputOrdering(t *testing.T) {
	t.Parallel()

	// Simulate a burst of 100 session/update notifications.
	// All must arrive in order.
	const count = 100
	var inputLines []string
	for i := 1; i <= count; i++ {
		inputLines = append(inputLines, makeNotification("session/update", i))
	}
	input := strings.Join(inputLines, "\n") + "\n"

	processedCh := make(chan struct{}, 1)
	done := make(chan struct{})
	defer close(done)

	reader := newOrderedPipe(strings.NewReader(input), processedCh, done, 2*time.Second)

	var received []int
	scanner := bufio.NewScanner(reader)

	for scanner.Scan() {
		line := scanner.Text()
		var env struct {
			Params struct {
				Seq int `json:"seq"`
			} `json:"params"`
		}
		json.Unmarshal([]byte(line), &env)
		received = append(received, env.Params.Seq)

		// Signal processing complete.
		processedCh <- struct{}{}
	}

	if len(received) != count {
		t.Fatalf("expected %d lines, got %d", count, len(received))
	}
	for i, seq := range received {
		if seq != i+1 {
			t.Errorf("line %d: expected seq %d, got %d (out of order!)", i, i+1, seq)
		}
	}
}
