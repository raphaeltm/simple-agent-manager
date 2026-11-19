package optout

type Opts struct{ Light bool }
type R struct{ Light bool }

func a(r *R, o Opts) {
	// sam:optional-field-ok full replacement, caller always supplies it
	// (second line of the reason)
	r.Light = o.Light
}

func b(r *R, o Opts) {
	doThing()         // sam:optional-field-ok unrelated trailing note
	r.Light = o.Light // want unguarded
}

func c(r *R, o Opts) {
	r.Light, _ = o.Light, 1 // sam:optional-field-ok
	r.Light = o.Light       //sam:optional-field-ok
}

func d(r *R, o Opts) {
	/* sam:optional-field-ok
	   multi-line reason */
	r.Light = o.Light
}

func doThing() {}
