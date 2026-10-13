package acp

import (
	"context"
	"time"
)

const secretExecutionWorkSource = "sam_secret_exec"

type secretExecutionWork struct {
	Deadline time.Time
	Cancel   context.CancelFunc
}

// TrackSecretExecution adds actual job-owned work, independent of ACP turn/tool
// notifications. It never starts a process or wakes a stopped session.
func (h *SessionHost) TrackSecretExecution(id string, deadline time.Time, cancel context.CancelFunc) bool {
	h.mu.RLock()
	if h.process == nil || h.status == HostStopped {
		h.mu.RUnlock()
		return false
	}
	h.secretWorkMu.Lock()
	if h.secretWork == nil {
		h.secretWork = make(map[string]secretExecutionWork)
	}
	h.secretWork[id] = secretExecutionWork{Deadline: deadline, Cancel: cancel}
	h.secretWorkObserved = true
	h.secretWorkProgressAt = time.Now()
	if h.secretWorkReporterCancel == nil && h.config.ActivityRereportInterval > 0 {
		ctx, stop := context.WithCancel(h.lifecycleContext())
		h.secretWorkReporterCancel = stop
		go h.reportSecretExecutionWork(ctx)
	}
	h.secretWorkMu.Unlock()
	h.mu.RUnlock()
	h.reportActivity(h.activityForHarnessWork())
	return true
}
func (h *SessionHost) reportSecretExecutionWork(ctx context.Context) {
	ticker := time.NewTicker(h.config.ActivityRereportInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !h.hasSecretExecutionWork() {
				return
			}
			h.reportActivity(h.activityForHarnessWork())
		}
	}
}
func (h *SessionHost) EndSecretExecution(id string) {
	h.secretWorkMu.Lock()
	delete(h.secretWork, id)
	h.secretWorkProgressAt = time.Now()
	if len(h.secretWork) == 0 && h.secretWorkReporterCancel != nil {
		h.secretWorkReporterCancel()
		h.secretWorkReporterCancel = nil
	}
	h.secretWorkMu.Unlock()
	h.reportActivity(h.activityForHarnessWork())
}
func (h *SessionHost) secretExecutionWorkSnapshot(base harnessWorkStatus) harnessWorkStatus {
	h.secretWorkMu.Lock()
	defer h.secretWorkMu.Unlock()
	now := time.Now()
	// Every job has a finite deadline. An orphaned entry cannot renew a lease indefinitely.
	for id, job := range h.secretWork {
		if !job.Deadline.After(now) {
			job.Cancel()
			delete(h.secretWork, id)
			h.secretWorkProgressAt = now
		}
	}
	if len(h.secretWork) == 0 && h.secretWorkReporterCancel != nil {
		h.secretWorkReporterCancel()
		h.secretWorkReporterCancel = nil
	}
	if len(h.secretWork) > 0 {
		count := len(h.secretWork)
		if base.State == harnessWorkActive {
			count += base.Count
		}
		return harnessWorkStatus{State: harnessWorkActive, Count: count, Source: secretExecutionWorkSource, ProgressAt: now}
	}
	if base.Source == "" && h.secretWorkObserved {
		return harnessWorkStatus{State: harnessWorkInactive, Source: secretExecutionWorkSource, ProgressAt: h.secretWorkProgressAt}
	}
	return base
}
func (h *SessionHost) hasSecretExecutionWork() bool {
	return h.secretExecutionWorkSnapshot(harnessWorkStatus{}).State == harnessWorkActive
}
func (h *SessionHost) cancelSecretExecutionWork() {
	h.secretWorkMu.Lock()
	jobs := h.secretWork
	h.secretWork = nil
	h.secretWorkProgressAt = time.Now()
	if h.secretWorkReporterCancel != nil {
		h.secretWorkReporterCancel()
		h.secretWorkReporterCancel = nil
	}
	h.secretWorkMu.Unlock()
	for _, job := range jobs {
		job.Cancel()
	}
}
