package contextcollect

import (
	"archive/tar"
	"bytes"
	"context"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

func TestRootedReadsRejectFifoWithoutBlocking(t *testing.T) {
	root := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0600); err != nil {
		t.Fatal(err)
	}
	opened := testRoot(t, root)
	p := &collectionPlan{root: root, source: opened}
	if file, err := p.open(filepath.Join(root, "pipe")); err == nil {
		file.Close()
		t.Fatal("FIFO accepted as a source file")
	}
	view := rootWalkFS{root: opened}
	file, err := view.Open("pipe")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.(fs.ReadDirFile).ReadDir(-1); err == nil {
		t.Fatal("FIFO accepted as directory")
	}
}

func TestOpenedRootRetainsOwnerAfterPathSwap(t *testing.T) {
	files := map[string]string{
		"compose.yaml":       "include:\n  - child/compose.yaml\nservices:\n  app:\n    build: .\n    env_file: runtime.env\n",
		"child/compose.yaml": "services:\n  worker:\n    build: ..\n",
		"Dockerfile":         "FROM scratch\nCOPY source /source\n",
		".dockerignore":      "ignored\n", "source": "OWNER", "ignored": "DROP",
		"runtime.env": "SECRET=RUNTIME_SECRET_MUST_NOT_APPEAR",
	}
	path := fixture(t, files)
	opened := testRoot(t, path)
	var owner map[string]string
	t.Run("owner", func(t *testing.T) {
		owner = bundleRoot(t, opened)
		if owner["source"] != "OWNER" || owner["runtime.env"] != "" {
			t.Fatal("owner control failed")
		}
	})
	t.Run("swap", func(t *testing.T) {
		outside := fixture(t, map[string]string{
			"compose.yaml":       "HOST_COMPOSE_CONTENT: [unterminated",
			"child/compose.yaml": "HOST_INCLUDE_CONTENT: [unterminated",
			".dockerignore":      "source\n", "Dockerfile": "HOST_DOCKERFILE_CONTENT", "source": "HOST_PAYLOAD_CONTENT",
		})
		pinned := path + "-pinned"
		if err := os.Rename(path, pinned); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(pinned) })
		if err := os.Symlink(outside, path); err != nil {
			t.Fatal(err)
		}
		got := bundleRoot(t, opened)
		if !reflect.DeepEqual(owner, got) {
			t.Fatalf("root pathname swap changed captured inputs: %v", got)
		}
	})
}

func TestRootedInputsRejectOutsideSymlinksWithOwnerControls(t *testing.T) {
	for _, name := range []string{"compose.yaml", "child.yaml", "base.yaml", "Dockerfile", ".dockerignore", "runtime.env"} {
		t.Run(name, func(t *testing.T) {
			root := fixture(t, map[string]string{
				"compose.yaml": "include: [child.yaml]\nservices:\n  app:\n    extends:\n      file: base.yaml\n      service: base\n    build: .\n    env_file: runtime.env\n",
				"child.yaml":   "services:\n  worker:\n    build: .\n", "base.yaml": "services:\n  base:\n    image: scratch\n",
				"Dockerfile": "FROM scratch\n", ".dockerignore": "ignored\n", "runtime.env": "SECRET=private",
			})
			opened := testRoot(t, root)
			if _, err := Collect(context.Background(), Options{Root: opened}, io.Discard); err != nil {
				t.Fatalf("owner control: %v", err)
			}
			outside := fixture(t, map[string]string{"target": "HOST_FILE_CONTENT_MUST_NOT_APPEAR: [unterminated"})
			if err := os.Remove(filepath.Join(root, name)); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(outside, "target"), filepath.Join(root, name)); err != nil {
				t.Fatal(err)
			}
			_, err := Collect(context.Background(), Options{Root: opened}, io.Discard)
			if err == nil {
				t.Fatal("outside input accepted")
			}
			if strings.Contains(err.Error(), "HOST_FILE_CONTENT_MUST_NOT_APPEAR") {
				t.Fatalf("host contents surfaced in error: %v", err)
			}
		})
	}
}

type headerSwapWriter struct {
	bytes.Buffer
	swap func()
}

func (w *headerSwapWriter) Write(p []byte) (int, error) {
	if w.swap != nil {
		f := w.swap
		w.swap = nil
		f()
	}
	return w.Buffer.Write(p)
}
func TestPayloadDescriptorSurvivesSecretPathSwap(t *testing.T) {
	for _, link := range []bool{false, true} {
		t.Run(map[bool]string{false: "symlink", true: "hardlink"}[link], func(t *testing.T) {
			root := fixture(t, map[string]string{"payload": "public", "runtime.env": "SECRET"})
			opened := testRoot(t, root)
			secret, err := opened.Stat("runtime.env")
			if err != nil {
				t.Fatal(err)
			}
			p := &collectionPlan{root: root, source: opened, empty: map[string]bool{filepath.Join(root, "runtime.env"): true}, sensitive: []os.FileInfo{secret}}
			out := &headerSwapWriter{swap: func() {
				if err := os.Remove(filepath.Join(root, "payload")); err != nil {
					t.Fatal(err)
				}
				var err error
				if link {
					err = os.Link(filepath.Join(root, "runtime.env"), filepath.Join(root, "payload"))
				} else {
					err = os.Symlink("runtime.env", filepath.Join(root, "payload"))
				}
				if err != nil {
					t.Fatal(err)
				}
			}}
			tw := tar.NewWriter(out)
			if err := writeEntry(context.Background(), tw, opened, p, filepath.Join(root, "payload"), "payload"); err != nil {
				t.Fatal(err)
			}
			if err := tw.Close(); err != nil {
				t.Fatal(err)
			}
			tr := tar.NewReader(&out.Buffer)
			if _, err := tr.Next(); err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(tr)
			if err != nil {
				t.Fatal(err)
			}
			if string(data) != "public" {
				t.Fatalf("path swap changed opened payload: %q", data)
			}
		})
	}
}
