package pty

import "sync"

// RingBuffer is a fixed-size circular buffer for capturing recent PTY output.
// It overwrites the oldest data when the buffer is full, maintaining a bounded
// memory footprint. Thread-safe for concurrent write and read access.
type RingBuffer struct {
	buf      []byte
	capacity int
	writePos int   // Next position to write at (wraps at capacity)
	written  int64 // Total bytes ever written (used to detect wrap-around)
	mu       sync.Mutex
}

// NewRingBuffer allocates a ring buffer with the given capacity in bytes.
func NewRingBuffer(capacity int) *RingBuffer {
	if capacity <= 0 {
		capacity = 262144 // 256 KB default
	}
	return &RingBuffer{
		buf:      make([]byte, capacity),
		capacity: capacity,
	}
}

// Write appends data to the buffer, overwriting the oldest bytes if full.
// Implements io.Writer.
func (rb *RingBuffer) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	rb.mu.Lock()
	defer rb.mu.Unlock()

	n := len(p)

	// If input is larger than capacity, only keep the last capacity bytes
	if n >= rb.capacity {
		copy(rb.buf, p[n-rb.capacity:])
		rb.writePos = 0
		rb.written += int64(n)
		return n, nil
	}

	// Write in up to two parts (before and after wrap-around)
	firstChunk := rb.capacity - rb.writePos
	if firstChunk >= n {
		// Fits without wrapping
		copy(rb.buf[rb.writePos:], p)
	} else {
		// Wraps around
		copy(rb.buf[rb.writePos:], p[:firstChunk])
		copy(rb.buf, p[firstChunk:])
	}

	rb.writePos = (rb.writePos + n) % rb.capacity
	rb.written += int64(n)
	return n, nil
}

// ReadAll returns a linearized copy of all buffered data in chronological order
// (oldest first). The returned slice is a copy and safe to use after the call.
func (rb *RingBuffer) ReadAll() []byte {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	length := rb.Len()
	if length == 0 {
		return nil
	}

	result := make([]byte, length)

	if rb.written <= int64(rb.capacity) {
		// Buffer has not wrapped — data is contiguous from start to writePos
		copy(result, rb.buf[:length])
	} else {
		// Buffer has wrapped — read from writePos to end, then start to writePos
		tailLen := rb.capacity - rb.writePos
		copy(result, rb.buf[rb.writePos:])
		copy(result[tailLen:], rb.buf[:rb.writePos])
	}

	return result
}

// Len returns the number of bytes currently stored in the buffer.
func (rb *RingBuffer) Len() int {
	if rb.written <= int64(rb.capacity) {
		return int(rb.written)
	}
	return rb.capacity
}

// Reset clears the buffer contents.
func (rb *RingBuffer) Reset() {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	rb.writePos = 0
	rb.written = 0
}
