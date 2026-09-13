package server

import (
	"context"
	"fmt"
	"sync"
)

type systemProvisioningBarrier struct {
	done chan struct{}
	err  error
}

// BeginSystemProvisioning must be called before Start. HTTP can serve liveness
// and boot logs while workspace Docker operations wait for host setup to finish.
// The returned function publishes the result once, before main starts bootstrap.
func (s *Server) BeginSystemProvisioning() func(error) {
	barrier := &systemProvisioningBarrier{done: make(chan struct{})}
	s.systemProvisioning = barrier
	var once sync.Once
	return func(err error) {
		once.Do(func() {
			barrier.err = err
			close(barrier.done)
		})
	}
}

func (s *Server) waitForSystemProvisioning(ctx context.Context) error {
	barrier := s.systemProvisioning
	if barrier == nil {
		return nil // Standalone/deployment mode has no workspace host setup phase.
	}
	if s.config.SystemProvisioningTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.config.SystemProvisioningTimeout)
		defer cancel()
	}
	select {
	case <-ctx.Done():
		return fmt.Errorf("waiting for system provisioning: %w", ctx.Err())
	case <-s.done:
		return fmt.Errorf("waiting for system provisioning: %w", context.Canceled)
	case <-barrier.done:
		if barrier.err != nil {
			return fmt.Errorf("system provisioning failed: %w", barrier.err)
		}
		return nil
	}
}
