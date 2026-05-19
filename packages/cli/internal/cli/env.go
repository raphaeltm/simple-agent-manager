package cli

import (
	"context"
	"os"
	"os/exec"
	"runtime"
)

type OSConfigEnv struct{}

func (OSConfigEnv) Getenv(key string) string {
	return os.Getenv(key)
}

func (OSConfigEnv) UserHomeDir() (string, error) {
	return os.UserHomeDir()
}

type OSRunner struct{}

func (OSRunner) GOOS() string {
	return runtime.GOOS
}

func (OSRunner) GOARCH() string {
	return runtime.GOARCH
}

func (OSRunner) LookPath(file string) (string, error) {
	return exec.LookPath(file)
}

func (OSRunner) Command(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}
