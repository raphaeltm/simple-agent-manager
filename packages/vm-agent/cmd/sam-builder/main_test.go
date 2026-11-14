package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/builder"
	"github.com/workspace/vm-agent/internal/sysinfo"
)

func launchFixture() builder.Launch {
	return builder.Launch{Token: "test-job-capability-canary", JobID: "job", ProjectID: "project", Attempt: 1, ControlPlaneURL: "https://control.invalid", DeadlineAt: time.Now().Add(time.Minute)}
}
func postLaunch(t *testing.T, client *http.Client, url string, launch builder.Launch) int {
	t.Helper()
	raw, err := json.Marshal(launch)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Post(url+"/start", "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), launch.Token) || strings.Contains(string(body), launch.ControlPlaneURL) {
		t.Fatal("launch capability reflected in response")
	}
	return response.StatusCode
}
func TestControllerAcceptsExactlyOneLaunchWithoutExposingCapabilities(t *testing.T) {
	launches := make(chan builder.Launch, 2)
	server := httptest.NewServer(controller(launches))
	defer server.Close()
	launch := launchFixture()
	if status := postLaunch(t, server.Client(), server.URL, launch); status != http.StatusAccepted {
		t.Fatalf("initial status %d", status)
	}
	received := <-launches
	if received.Token != launch.Token || received.ControlPlaneURL != launch.ControlPlaneURL {
		t.Fatal("accepted launch changed")
	}
	replacement := launch
	replacement.Token = "replacement-capability"
	replacement.ControlPlaneURL = "https://replacement.invalid"
	if status := postLaunch(t, server.Client(), server.URL, replacement); status != http.StatusConflict {
		t.Fatalf("second status %d", status)
	}
	select {
	case <-launches:
		t.Fatal("second launch reached executor")
	default:
	}
	response, err := server.Client().Get(server.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var health map[string]string
	if err := json.NewDecoder(response.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	if len(health) != 1 || health["version"] != sysinfo.Version {
		t.Fatal("health exposes fields other than version")
	}
	for _, path := range []string{"/spec", "/token", "/start"} {
		r, err := server.Client().Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode < 400 || strings.Contains(string(raw), launch.Token) {
			t.Fatalf("unsafe GET %s", path)
		}
	}
}
func TestBootstrapClosesListenerBeforeBuildExecution(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	finished := make(chan error, 1)
	address := listener.Addr().String()
	go func() {
		finished <- serveController(ctx, listener, time.Second, time.Second, func(_ context.Context, launch builder.Launch) error {
			connection, err := net.DialTimeout("tcp", address, 100*time.Millisecond)
			if err == nil {
				connection.Close()
				return errors.New("bootstrap port reachable during build execution")
			}
			if launch.Token != launchFixture().Token {
				return errors.New("launch capability changed")
			}
			return nil
		})
	}()
	client := &http.Client{Timeout: 2 * time.Second}
	if status := postLaunch(t, client, "http://"+address, launchFixture()); status != http.StatusAccepted {
		t.Fatalf("status %d", status)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("executor did not finish")
	}
}
func TestCanceledBootstrapClosesWithoutStartingBuild(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := serveController(ctx, listener, time.Second, time.Second, func(context.Context, builder.Launch) error { t.Fatal("canceled bootstrap executed job"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("error %v", err)
	}
	connection, err := net.DialTimeout("tcp", listener.Addr().String(), 100*time.Millisecond)
	if err == nil {
		connection.Close()
		t.Fatal("canceled bootstrap retained listener")
	}
}
