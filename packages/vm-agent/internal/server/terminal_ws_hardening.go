package server

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/pty"
)

type terminalWSLimiter struct {
	rate       int
	burst      int
	tokens     int
	lastRefill time.Time
}

func newTerminalWSLimiter(rate, burst int) *terminalWSLimiter {
	if rate <= 0 {
		rate = config.DefaultTerminalWSMessageRate
	}
	if burst <= 0 {
		burst = config.DefaultTerminalWSMessageBurst
	}
	return &terminalWSLimiter{rate: rate, burst: burst, tokens: burst, lastRefill: time.Now()}
}

func (l *terminalWSLimiter) allow(now time.Time) bool {
	if l == nil {
		return true
	}
	elapsed := now.Sub(l.lastRefill)
	if elapsed > 0 {
		refill := int(elapsed.Seconds() * float64(l.rate))
		if refill > 0 {
			l.tokens += refill
			if l.tokens > l.burst {
				l.tokens = l.burst
			}
			l.lastRefill = now
		}
	}
	if l.tokens <= 0 {
		return false
	}
	l.tokens--
	return true
}

func (s *Server) configureTerminalWebSocket(conn *websocket.Conn, writeMu *sync.Mutex) func() {
	maxMessageBytes := s.config.TerminalWSMaxMessageBytes
	if maxMessageBytes <= 0 {
		maxMessageBytes = config.DefaultTerminalWSMaxMessageBytes
	}
	readTimeout := s.config.TerminalWSReadTimeout
	if readTimeout <= 0 {
		readTimeout = config.DefaultTerminalWSReadTimeout
	}
	pingInterval := s.config.TerminalWSPingInterval
	if pingInterval <= 0 {
		pingInterval = config.DefaultTerminalWSPingInterval
	}
	conn.SetReadLimit(maxMessageBytes)
	_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(readTimeout))
	})
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				writeMu.Lock()
				err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(readTimeout))
				writeMu.Unlock()
				if err != nil {
					return
				}
			case <-stop:
				return
			}
		}
	}()
	return func() { close(stop) }
}

func (s *Server) validateTerminalSessionID(sessionID string) error {
	maxLength := config.DefaultTerminalSessionIDMaxLength
	if s != nil && s.config != nil && s.config.TerminalSessionIDMaxLength > 0 {
		maxLength = s.config.TerminalSessionIDMaxLength
	}
	return pty.ValidateSessionIDWithMaxLength(sessionID, maxLength)
}
