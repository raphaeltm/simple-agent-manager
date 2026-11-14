package builder

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestCallbackRetriesTransientFailureWithIdenticalBodyAndToken(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer job-token" {
			t.Error("missing job token")
		}
		raw, _ := io.ReadAll(r.Body)
		if string(raw) != "{\"terminal\":true}" {
			t.Errorf("body changed %q", raw)
		}
		if calls.Add(1) == 1 {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(200)
	}))
	defer server.Close()
	launch := Launch{Token: "job-token"}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := launch.send(ctx, http.MethodPost, server.URL, map[string]bool{"terminal": true}, nil); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls %d", calls.Load())
	}
}
func TestCallbackStopsImmediatelyOnRevocationAndCancelsRetryDelay(t *testing.T) {
	for _, status := range []int{401, 403, 404, 409, 410} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(status) }))
			defer server.Close()
			if err := (Launch{}).send(context.Background(), http.MethodPost, server.URL, nil, nil); err == nil {
				t.Fatal("revocation accepted")
			}
			if calls.Load() != 1 {
				t.Fatal("retried revoked token")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503); cancel() }))
	defer server.Close()
	started := time.Now()
	if err := (Launch{}).send(ctx, http.MethodPost, server.URL, nil, nil); err == nil {
		t.Fatal("cancellation ignored")
	}
	if time.Since(started) > time.Second {
		t.Fatal("retry delay ignored cancellation")
	}
}
