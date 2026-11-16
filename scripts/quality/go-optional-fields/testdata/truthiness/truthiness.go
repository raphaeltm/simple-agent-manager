package truthiness

type syncOpts struct {
	Force   bool
	Retries int
}

type State struct {
	Force   bool
	Retries int
}

func apply(state *State, opts ...syncOpts) {
	for _, opt := range opts {
		if opt.Force {
			state.Force = opt.Force
		}
		if opt.Retries != 0 {
			state.Retries = opt.Retries
		}
	}
}
