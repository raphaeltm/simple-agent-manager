package fn

import "time"

type Opts struct {
	Name    string
	Light   bool
	Count   int
	Timeout time.Duration
}
type Embedded struct{ Light bool }
type OptsE struct {
	Embedded
	Name string
}
type R struct {
	Name    string
	Light   bool
	Count   int
	Timeout time.Duration
	flags   map[string]bool
}
type S struct{ m map[string]*R }

func (s *S) base(id string, opts ...Opts) { // L1 expect
	var opt Opts
	if len(opts) > 0 {
		opt = opts[0]
	}
	r := s.m[id]
	r.Light = opt.Light // want unguarded
}

func (s *S) direct(id string, opts ...Opts) { // L2
	r := s.m[id]
	if len(opts) > 0 {
		r.Light = opts[0].Light // want unguarded
	}
}

func (s *S) varDecl(id string, opts ...Opts) { // L3
	r := s.m[id]
	var opt = opts[0]
	r.Light = opt.Light // want unguarded
}

func (o Opts) applyTo(r *R)   { r.Light = o.Light } // L4a // want unguarded
func (o *Opts) applyTo2(r *R) { r.Light = o.Light } // L4b // want unguarded

func (s *S) wrapped(id string, o Opts) { // L5
	r := s.m[id]
	r.Light = !o.Light                               // want unguarded
	r.Timeout = time.Duration(o.Count) * time.Second // want unguarded
	r.Count = o.Count + 0                            // want unguarded
	r.Timeout = time.Duration(o.Timeout)             // want unguarded
}

func (s *S) constAssign(id string, o Opts) { // L6
	r := s.m[id]
	if o.Light {
		r.Light = true // want truthiness
	}
}

func (s *S) embedded(id string, opts ...OptsE) { // L7
	r := s.m[id]
	opt := opts[0]
	r.Light = opt.Light // want unguarded
}

func setB(p *bool, v bool) { *p = v }
func (s *S) helper(id string, o Opts) { // L8
	r := s.m[id]
	setB(&r.Light, o.Light)
	p := &r.Light
	*p = o.Light           // want unguarded
	r.flags["x"] = o.Light // want unguarded
}

func (s *S) get(id string) *R { return s.m[id] }
func (s *S) callTarget(id string, o Opts) { // L9
	s.get(id).Light = o.Light // want unguarded
}

func (s *S) replace(id string, o Opts) { // L10
	s.m[id] = &R{Name: "x", Light: o.Light}
}

func (s *S) ptrVar(id string, opts ...*Opts) { // L11
	r := s.m[id]
	opt := *opts[0]
	r.Light = opt.Light // want unguarded
}
func (s *S) idx(id string, opts ...Opts) { // L12
	r := s.m[id]
	for i := range opts {
		r.Light = opts[i].Light // want unguarded
	}
}
func (s *S) closure(id string, o Opts) { // L13
	r := s.m[id]
	func() { r.Light = o.Light }()       // want unguarded
	defer func() { r.Count = o.Count }() // want unguarded
	go func() { r.Count = o.Count }()    // want unguarded
}
func (s *S) sw(id string, o Opts) { // L14
	r := s.m[id]
	switch {
	case o.Name == "a":
		r.Light = o.Light // want unguarded
	default:
		r.Count = o.Count // want unguarded
	}
}
func (s *S) elseif(id string, o Opts) { // L15
	r := s.m[id]
	if o.Name != "" {
		r.Name = o.Name
	} else if o.Count > 5 {
		r.Light = o.Light // want unguarded
	} else {
		r.Count = o.Count // want unguarded
	}
}
func (s *S) multi(id string, o Opts) { // L16
	r := s.m[id]
	r.Name, r.Light = o.Name, o.Light // want unguarded
}
func (s *S) shadow(id string, o Opts, rs []*R) { // L17
	{
		r := &R{}
		r.Light = o.Light // want unguarded
	}
	for _, r := range rs {
		r.Light = o.Light // want unguarded
	}
}
func (s *S) shadow2(r *R, o Opts) { // L18
	func() {
		r := &R{}
		_ = r
	}()
	r.Light = o.Light // want unguarded
}

var lit = func(r *R, o Opts) { r.Light = o.Light } // L19 // want unguarded
