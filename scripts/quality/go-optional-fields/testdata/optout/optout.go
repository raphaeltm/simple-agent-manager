package optout

type replaceOpts struct{ Enabled bool }

type State struct{ Enabled bool }

// Replace is a full replacement: every field is meant to be written.
func replace(state *State, opts ...replaceOpts) {
	for _, opt := range opts {
		//sam:optional-field-ok full replacement, callers always pass every field
		state.Enabled = opt.Enabled
	}
}
