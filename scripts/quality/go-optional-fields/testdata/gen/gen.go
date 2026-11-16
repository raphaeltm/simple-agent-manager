package gen

type Opts[T any] struct {
	On bool
	V  T
}
type Alias = Opts[int]
type Rec struct{ On bool }

func F[T any](r *Rec, opts ...Opts[T]) { r.On = opts[0].On } // want unguarded
func G(r *Rec, opts ...Alias)          { r.On = opts[0].On } // want unguarded
func H[T ~int](r *Rec, o Opts[T])      { r.On = o.On }       // want unguarded
