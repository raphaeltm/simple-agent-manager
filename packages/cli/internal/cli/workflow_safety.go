package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type timeoutHTTPDoer struct {
	next    HTTPDoer
	timeout time.Duration
}

func (d timeoutHTTPDoer) Do(req *http.Request) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(req.Context(), d.timeout)
	request := req.Clone(ctx)
	res, err := d.next.Do(request)
	if err != nil {
		cancel()
		return nil, err
	}
	res.Body = cancelBody{res.Body, cancel}
	return res, nil
}

type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b cancelBody) Close() error { defer b.cancel(); return b.ReadCloser.Close() }

type redactingWriter struct {
	destination io.Writer
	secrets     []string
}

func (w redactingWriter) Write(p []byte) (int, error) {
	s := string(p)
	for _, secret := range w.secrets {
		if len(secret) >= 4 {
			s = strings.ReplaceAll(s, secret, "REDACTED")
		}
	}
	_, err := io.WriteString(w.destination, s)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}
func secureRuntime(runtime Runtime) (Runtime, error) {
	timeout := 60 * time.Second
	if v := runtime.Env.Getenv("SAM_CLI_HTTP_TIMEOUT"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return runtime, fmt.Errorf("SAM_CLI_HTTP_TIMEOUT must be a positive duration")
		}
		timeout = d
	}
	runtime.HTTPClient = timeoutHTTPDoer{runtime.HTTPClient, timeout}
	secrets := []string{runtime.Env.Getenv("SAM_API_TOKEN"), runtime.Env.Getenv("SAM_SESSION_COOKIE")}
	if config, err := LoadConfig(runtime.Env); err == nil && config != nil {
		secrets = append(secrets, config.SessionCookie)
	}
	runtime.Stderr = redactingWriter{runtime.Stderr, secrets}
	return runtime, nil
}

func workflowByteLimit(runtime Runtime, name string, fallback int64) (int64, error) {
	raw := runtime.Env.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 || value >= 1<<62 {
		return 0, fmt.Errorf("%s must be a positive byte count", name)
	}
	return value, nil
}
