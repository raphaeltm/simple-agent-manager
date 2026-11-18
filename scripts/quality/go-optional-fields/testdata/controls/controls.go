package controls

import "time"

type workerOptions struct {
	Name     string
	Enabled  bool
	Interval time.Duration
	Retries  int
}

type Worker struct {
	Name     string
	Enabled  bool
	Interval time.Duration
	Retries  int
}

type Store struct{ workers map[string]*Worker }

// Construction: every field copied onto a value this function builds is fine.
func newWorker(opts ...workerOptions) *Worker {
	var opt workerOptions
	if len(opts) > 0 {
		opt = opts[0]
	}
	w := &Worker{}
	w.Enabled = opt.Enabled
	w.Interval = opt.Interval
	built := Worker{Name: opt.Name, Enabled: opt.Enabled}
	_ = built
	return w
}

// A guard that mentions the field and can express false is fine.
func (s *Store) update(id string, set bool, opts ...workerOptions) {
	for _, opt := range opts {
		w := s.workers[id]
		if set || opt.Enabled {
			w.Enabled = opt.Enabled
		}
		w.Name = opt.Name // strings use the zero-value-is-absent convention
	}
}

// A non-options parameter is not an options value.
func (s *Store) replace(id string, worker Worker) {
	existing := s.workers[id]
	existing.Enabled = worker.Enabled
}
