package server

import (
	"context"
	"sync"
)

// Serialize a session's create handlers through reporter/MCP/tab setup. The
// manager entry alone is not a completed create result: hosts capture the
// reporter at construction, so no retry may publish success before setup ends.
func (s *Server) beginSessionCreation(ctx context.Context, workspaceID, sessionID string) (func(), error) {
	key := workspaceID + ":" + sessionID
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		s.sessionHostMu.Lock()
		if pending := s.sessionCreations[key]; pending != nil {
			s.sessionHostMu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-pending:
				continue
			}
		}
		if s.sessionCreations == nil {
			s.sessionCreations = make(map[string]chan struct{})
		}
		done := make(chan struct{})
		s.sessionCreations[key] = done
		s.sessionHostMu.Unlock()
		var once sync.Once
		return func() {
			once.Do(func() {
				s.sessionHostMu.Lock()
				delete(s.sessionCreations, key)
				close(done)
				s.sessionHostMu.Unlock()
			})
		}, nil
	}
}
