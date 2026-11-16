package load

import "encoding/json"

type Opts struct {
	Name  string
	Light bool
}
type R struct {
	Name  string
	Light bool
}
type S struct{ m map[string]*R }

func (s *S) load(id string, r *R) {}

func (s *S) derefCopy(id string, opts ...Opts) { // A
	opt := opts[0]
	rt := &R{}
	if existing, ok := s.m[id]; ok {
		*rt = *existing
	}
	rt.Light = opt.Light // want unguarded
	s.m[id] = rt
}

func (s *S) loadInto(id string, opts ...Opts) { // B
	opt := opts[0]
	rt := new(R)
	s.load(id, rt)
	rt.Light = opt.Light // want unguarded
}

func (s *S) unmarshal(data []byte, opts ...Opts) { // C
	opt := opts[0]
	var rt R
	_ = json.Unmarshal(data, &rt)
	rt.Light = opt.Light // want unguarded
}

func (s *S) structCopy(id string, opts ...Opts) { // D
	opt := opts[0]
	next := R{Name: s.m[id].Name}
	next.Light = opt.Light // want unguarded
	s.m[id] = &next
}
