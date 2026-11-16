package fixed

// opts mirrors the shape after #2055: the bool is a pointer and is applied only when set.
type runtimeOpts struct {
	Name        string
	Lightweight *bool
}

type Runtime struct {
	Name        string
	Lightweight bool
}

type Server struct{ runtimes map[string]*Runtime }

func (s *Server) upsert(id string, opts ...runtimeOpts) *Runtime {
	var opt runtimeOpts
	if len(opts) > 0 {
		opt = opts[0]
	}
	runtime := s.runtimes[id]
	if opt.Name != "" {
		runtime.Name = opt.Name
	}
	if opt.Lightweight != nil {
		runtime.Lightweight = *opt.Lightweight
	}
	return runtime
}
