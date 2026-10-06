package fakedocker

import (
	"os"
	"path/filepath"
	"testing"
)

// InstallExec puts a tiny fake docker binary at the front of PATH for tests
// that need to exercise docker-exec argument construction without requiring a
// Docker daemon or container on the test runner.
func InstallExec(t testing.TB) {
	t.Helper()

	dir := t.TempDir()
	dockerPath := filepath.Join(dir, "docker")
	script := `#!/bin/sh
if [ "$1" != "exec" ]; then
  echo "fake docker only supports exec" >&2
  exit 1
fi
shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    -i|-t|-it|-ti)
      shift
      ;;
    -u|-w|-e)
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      shift
      ;;
    *)
      shift
      break
      ;;
  esac
done
if [ "$#" -eq 0 ]; then
  exit 0
fi
exec "$@"
`
	if err := os.WriteFile(dockerPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake docker: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}
