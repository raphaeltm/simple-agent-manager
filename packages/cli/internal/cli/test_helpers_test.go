package cli

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type fakeEnv struct {
	values map[string]string
	home   string
}

func (e fakeEnv) Getenv(key string) string {
	return e.values[key]
}

func (e fakeEnv) UserHomeDir() (string, error) {
	if e.home != "" {
		return e.home, nil
	}
	return os.UserHomeDir()
}

type roundTripFunc func(req *http.Request) (*http.Response, error)

func (f roundTripFunc) Do(req *http.Request) (*http.Response, error) {
	return f(req)
}

type fakeRunner struct {
	goos     string
	goarch   string
	paths    map[string]string
	outputs  map[string][]byte
	failures map[string]error
}

func (r fakeRunner) GOOS() string {
	if r.goos != "" {
		return r.goos
	}
	return runtime.GOOS
}

func (r fakeRunner) GOARCH() string {
	if r.goarch != "" {
		return r.goarch
	}
	return runtime.GOARCH
}

func (r fakeRunner) LookPath(file string) (string, error) {
	if path, ok := r.paths[file]; ok {
		return path, nil
	}
	return "", os.ErrNotExist
}

func (r fakeRunner) Command(_ context.Context, name string, args ...string) ([]byte, error) {
	key := name
	for _, arg := range args {
		key += " " + arg
	}
	return r.outputs[key], r.failures[key]
}

func testRuntime(t *testing.T, args []string, doer HTTPDoer, env map[string]string) (Runtime, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	if doer == nil {
		doer = roundTripFunc(func(*http.Request) (*http.Response, error) {
			return jsonResponse(`{}`, http.StatusOK), nil
		})
	}
	if env == nil {
		env = map[string]string{
			"SAM_API_URL":        "https://api.example.com",
			"SAM_SESSION_COOKIE": "cookie=value",
		}
	}
	return Runtime{
		Args:       args,
		Env:        fakeEnv{values: env, home: t.TempDir()},
		HTTPClient: doer,
		Stdin:      bytes.NewBuffer(nil),
		Stdout:     stdout,
		Stderr:     stderr,
		Runner: fakeRunner{
			goos:   "linux",
			goarch: "amd64",
			paths: map[string]string{
				"docker":    "/usr/bin/docker",
				"systemctl": "/usr/bin/systemctl",
				"vm-agent":  "/usr/local/bin/vm-agent",
			},
			outputs: map[string][]byte{
				"docker version --format {{.Server.Version}}": []byte("25.0.0\n"),
				"systemctl is-system-running":                 []byte("running\n"),
			},
			failures: map[string]error{},
		},
	}, stdout, stderr
}

func jsonResponse(body string, status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(bytes.NewBufferString(body)),
		Header:     make(http.Header),
	}
}

func tempConfigEnv(t *testing.T) fakeEnv {
	t.Helper()
	return fakeEnv{values: map[string]string{"SAM_CONFIG_DIR": filepath.Join(t.TempDir(), "sam")}}
}
