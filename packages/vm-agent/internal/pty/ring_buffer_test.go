package pty

import (
	"bytes"
	"sync"
	"testing"
)

func TestRingBuffer_WriteUnderCapacity(t *testing.T) {
	rb := NewRingBuffer(64)
	data := []byte("hello world")
	n, err := rb.Write(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != len(data) {
		t.Fatalf("expected %d bytes written, got %d", len(data), n)
	}
	if rb.Len() != len(data) {
		t.Fatalf("expected len %d, got %d", len(data), rb.Len())
	}
	got := rb.ReadAll()
	if !bytes.Equal(got, data) {
		t.Fatalf("expected %q, got %q", data, got)
	}
}

func TestRingBuffer_WriteAtCapacity(t *testing.T) {
	rb := NewRingBuffer(8)
	data := []byte("12345678")
	rb.Write(data)
	if rb.Len() != 8 {
		t.Fatalf("expected len 8, got %d", rb.Len())
	}
	got := rb.ReadAll()
	if !bytes.Equal(got, data) {
		t.Fatalf("expected %q, got %q", data, got)
	}
}

func TestRingBuffer_WrapAround(t *testing.T) {
	rb := NewRingBuffer(8)
	// Write 6 bytes, then write 5 more (total 11, wraps)
	rb.Write([]byte("abcdef"))
	rb.Write([]byte("ghijk"))

	if rb.Len() != 8 {
		t.Fatalf("expected len 8, got %d", rb.Len())
	}
	got := rb.ReadAll()
	// Should contain the last 8 bytes: "defghijk"
	expected := []byte("defghijk")
	if !bytes.Equal(got, expected) {
		t.Fatalf("expected %q, got %q", expected, got)
	}
}

func TestRingBuffer_WriteLargerThanCapacity(t *testing.T) {
	rb := NewRingBuffer(4)
	data := []byte("abcdefghij") // 10 bytes, capacity 4
	n, err := rb.Write(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 10 {
		t.Fatalf("expected 10 bytes written, got %d", n)
	}
	got := rb.ReadAll()
	// Should contain last 4 bytes: "ghij"
	expected := []byte("ghij")
	if !bytes.Equal(got, expected) {
		t.Fatalf("expected %q, got %q", expected, got)
	}
}

func TestRingBuffer_ReadAllLinearizesCorrectly(t *testing.T) {
	rb := NewRingBuffer(10)

	// Write in three chunks to force wrap-around
	rb.Write([]byte("AAAA"))  // pos now at 4
	rb.Write([]byte("BBBB"))  // pos now at 8
	rb.Write([]byte("CCCC"))  // wraps: pos now at 2

	got := rb.ReadAll()
	// Should be last 10 bytes of "AAAABBBBCCCC" (12 bytes) = "AABBBBCCCC"
	expected := []byte("AABBBBCCCC")
	if !bytes.Equal(got, expected) {
		t.Fatalf("expected %q, got %q", expected, got)
	}
}

func TestRingBuffer_MultipleSmallWrites(t *testing.T) {
	rb := NewRingBuffer(6)
	for _, b := range []byte("abcdefghij") {
		rb.Write([]byte{b})
	}
	got := rb.ReadAll()
	expected := []byte("efghij") // last 6 bytes
	if !bytes.Equal(got, expected) {
		t.Fatalf("expected %q, got %q", expected, got)
	}
}

func TestRingBuffer_EmptyBuffer(t *testing.T) {
	rb := NewRingBuffer(64)
	if rb.Len() != 0 {
		t.Fatalf("expected len 0, got %d", rb.Len())
	}
	got := rb.ReadAll()
	if got != nil {
		t.Fatalf("expected nil for empty buffer, got %v", got)
	}
}

func TestRingBuffer_ZeroLengthWrite(t *testing.T) {
	rb := NewRingBuffer(64)
	n, err := rb.Write([]byte{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Fatalf("expected 0 bytes written, got %d", n)
	}
	if rb.Len() != 0 {
		t.Fatalf("expected len 0 after empty write, got %d", rb.Len())
	}
}

func TestRingBuffer_Reset(t *testing.T) {
	rb := NewRingBuffer(64)
	rb.Write([]byte("hello"))
	rb.Reset()
	if rb.Len() != 0 {
		t.Fatalf("expected len 0 after reset, got %d", rb.Len())
	}
	got := rb.ReadAll()
	if got != nil {
		t.Fatalf("expected nil after reset, got %v", got)
	}

	// Can write again after reset
	rb.Write([]byte("world"))
	got = rb.ReadAll()
	if !bytes.Equal(got, []byte("world")) {
		t.Fatalf("expected 'world' after reset+write, got %q", got)
	}
}

func TestRingBuffer_ConcurrentWriteRead(t *testing.T) {
	rb := NewRingBuffer(1024)
	var wg sync.WaitGroup

	// Writer goroutine
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			rb.Write([]byte("data chunk "))
		}
	}()

	// Reader goroutine
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			_ = rb.ReadAll()
			_ = rb.Len()
		}
	}()

	wg.Wait()

	// Should not panic and should have valid data
	if rb.Len() > 1024 {
		t.Fatalf("len should not exceed capacity, got %d", rb.Len())
	}
	got := rb.ReadAll()
	if len(got) != rb.Len() {
		t.Fatalf("ReadAll length %d != Len() %d", len(got), rb.Len())
	}
}

func TestRingBuffer_DefaultCapacity(t *testing.T) {
	rb := NewRingBuffer(0)
	if rb.capacity != 262144 {
		t.Fatalf("expected default capacity 262144, got %d", rb.capacity)
	}

	rb2 := NewRingBuffer(-1)
	if rb2.capacity != 262144 {
		t.Fatalf("expected default capacity 262144 for negative input, got %d", rb2.capacity)
	}
}
