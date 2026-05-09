package sample

import "context"

// Options configures the sample.
type Options struct {
	Name    string
	Verbose bool
}

// Result holds output data.
type Result struct {
	Value int
	Error error
}

// Runner is the main interface.
type Runner interface {
	Run(ctx context.Context) (*Result, error)
	Stop() error
}

// MaxRetries is the default retry count.
const MaxRetries = 3

// DefaultTimeout is the default timeout.
var DefaultTimeout = 30

func Run(ctx context.Context, opts Options) (*Result, error) {
	return &Result{Value: 42}, nil
}

func (r *Result) String() string {
	return "result"
}

func helperFunc() {
	// unexported, should not appear in exported vars/consts
}
