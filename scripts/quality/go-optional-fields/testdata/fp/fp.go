package fp

type Sample struct {
	Value float64
	Ok    bool
}
type Metrics struct {
	last float64
	ok   bool
}

func (m *Metrics) Observe(samples ...Sample) {
	for _, s := range samples {
		m.last = s.Value
		m.ok = s.Ok
	}
}

type StatusUpdate struct {
	Running bool
	Port    int
}
type Host struct {
	running bool
	port    int
}

func (h *Host) handle(u StatusUpdate) {
	h.running = u.Running
	h.port = u.Port
}

type ServerOptions struct{ Debug bool }
type Server struct{ debug bool }

func (s *Server) init(opts ServerOptions) { s.debug = opts.Debug } // want unguarded

type PresenceOpts struct {
	Light    bool
	HasLight bool
}
type Rec struct{ Light bool }

func (r *Rec) apply(o PresenceOpts) {
	if o.HasLight {
		r.Light = o.Light
	}
}
func (r *Rec) early(o PresenceOpts) {
	if !o.HasLight {
		return
	}
	r.Light = o.Light
}

type ModeOpts struct{ Mode int }
type Rec2 struct{ Mode int }

func (r *Rec2) sw(o ModeOpts) {
	switch o.Mode {
	case 1, 2:
		r.Mode = o.Mode
	}
}
func (r *Rec2) cmp(o ModeOpts) {
	if o.Mode != r.Mode {
		r.Mode = o.Mode // want unguarded
	}
}
func (r *Rec) rng(opts ...PresenceOpts) {
	for _, o := range opts {
		r.Light = o.Light // want unguarded
	}
}
func (r *Rec2) nested(o ModeOpts) {
	if o.Mode > 0 {
		if o.Mode != r.Mode {
			r.Mode = o.Mode // want truthiness
		}
	}
}
func (r *Rec2) andGuard(o ModeOpts, ok bool) {
	if ok && o.Mode > 0 {
		r.Mode = o.Mode // want truthiness
	}
}
func (r *Rec) eqTrue(o PresenceOpts) {
	if o.Light == true {
		r.Light = o.Light // want truthiness
	}
}
func (r *Rec) neg(o PresenceOpts) {
	if !o.Light {
		return
	}
	r.Light = o.Light // want truthiness
}
