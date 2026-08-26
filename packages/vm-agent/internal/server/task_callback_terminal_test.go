package server

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestTaskCallbackTerminalStatusLatchesControlPlaneCallbacks(t *testing.T) {
	var mu sync.Mutex
	requests := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		w.WriteHeader(http.StatusGone)
		_, _ = w.Write([]byte("terminal task callback resource"))
	}))
	defer api.Close()

	s := &Server{httpClient: api.Client()}
	s.postTaskCallback(api.URL, "task-1", "callback-token", map[string]interface{}{"status": "running"})

	if !s.controlPlaneCallbacksStopped() {
		t.Fatal("terminal task callback status did not latch callback stop state")
	}

	s.postTaskCallback(api.URL, "task-1", "callback-token", map[string]interface{}{"status": "failed"})

	mu.Lock()
	defer mu.Unlock()
	if requests != 1 {
		t.Fatalf("latched terminal callback should skip later task callbacks, got %d requests", requests)
	}
}
