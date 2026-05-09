package workers

import "fmt"

// Scheduler manages background job scheduling.
type Scheduler struct {
	interval int
}

// NewScheduler creates a scheduler with the given check interval in seconds.
func NewScheduler(intervalSecs int) *Scheduler {
	return &Scheduler{interval: intervalSecs}
}

// Start begins the scheduling loop.
func (s *Scheduler) Start() {
	fmt.Println("Scheduler started")
}
