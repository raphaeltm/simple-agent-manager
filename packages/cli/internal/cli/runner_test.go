package cli

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestRunnerDoctorReady(t *testing.T) {
	report := RunRunnerDoctor(context.Background(), fakeRunner{
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
	})
	if !report.Ready {
		t.Fatalf("expected ready report: %#v", report)
	}
	text := FormatRunnerDoctor(report)
	if !strings.Contains(text, "Docker daemon: ok") || !strings.Contains(text, "vm-agent: ok") {
		t.Fatalf("unexpected text: %s", text)
	}
}

func TestRunnerDoctorTreatsMissingVMAgentAsWarning(t *testing.T) {
	report := RunRunnerDoctor(context.Background(), fakeRunner{
		goos:   "linux",
		goarch: "amd64",
		paths: map[string]string{
			"docker":    "/usr/bin/docker",
			"systemctl": "/usr/bin/systemctl",
		},
		outputs: map[string][]byte{
			"docker version --format {{.Server.Version}}": []byte("25.0.0\n"),
			"systemctl is-system-running":                 []byte("running\n"),
		},
		failures: map[string]error{},
	})
	if !report.Ready {
		t.Fatalf("missing vm-agent should be warning, got %#v", report)
	}
}

func TestRunnerDoctorFailsWhenDockerDaemonUnavailable(t *testing.T) {
	report := RunRunnerDoctor(context.Background(), fakeRunner{
		goos:   "linux",
		goarch: "amd64",
		paths: map[string]string{
			"docker":    "/usr/bin/docker",
			"systemctl": "/usr/bin/systemctl",
		},
		outputs: map[string][]byte{
			"docker version --format {{.Server.Version}}": []byte("daemon unavailable\n"),
			"systemctl is-system-running":                 []byte("running\n"),
		},
		failures: map[string]error{
			"docker version --format {{.Server.Version}}": errors.New("exit 1"),
		},
	})
	if report.Ready {
		t.Fatalf("expected not ready: %#v", report)
	}
}

func TestRunnerDoctorMarksSystemdAsWarningOnNonLinuxHosts(t *testing.T) {
	report := RunRunnerDoctor(context.Background(), fakeRunner{
		goos:   "darwin",
		goarch: "arm64",
		paths: map[string]string{
			"docker":   "/usr/local/bin/docker",
			"vm-agent": "/usr/local/bin/vm-agent",
		},
		outputs: map[string][]byte{
			"docker version --format {{.Server.Version}}": []byte("25.0.0\n"),
		},
		failures: map[string]error{},
	})
	if !report.Ready {
		t.Fatalf("non-Linux systemd check should be warning-only: %#v", report)
	}
	text := FormatRunnerDoctor(report)
	if !strings.Contains(text, "systemd: warning") {
		t.Fatalf("expected systemd warning in output: %s", text)
	}
}
