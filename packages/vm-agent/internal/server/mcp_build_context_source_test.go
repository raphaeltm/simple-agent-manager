package server

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestContextSourceWorkingDirectorySwap(t *testing.T) {
	for _, standalone := range []bool{false, true} {
		name := "VM"
		if standalone {
			name = "Instant"
		}
		t.Run(name, func(t *testing.T) {
			for _, attack := range []bool{false, true} {
				name := "owner"
				if attack {
					name = "swap"
				}
				t.Run(name, func(t *testing.T) {
					s, _ := mcpBuildTestServer(t)
					s.config.Role = config.RoleWorkspace
					s.config.ContainerMode = true
					mount := t.TempDir()
					work := "/workspaces/work"
					if standalone {
						s.config.Role = config.RoleStandalone
						s.config.ContainerMode = false
						var err error
						mount, err = os.MkdirTemp("/workspaces", "context-source-swap-")
						if err != nil {
							t.Fatal(err)
						}
						t.Cleanup(func() { os.RemoveAll(mount) })
						work = filepath.Join(mount, "work")
					}
					owned := filepath.Join(mount, "work")
					if err := os.Mkdir(owned, 0700); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(owned, "marker"), []byte("OWNER"), 0600); err != nil {
						t.Fatal(err)
					}
					outside := t.TempDir()
					if err := os.WriteFile(filepath.Join(outside, "marker"), []byte("HOST_SECRET"), 0600); err != nil {
						t.Fatal(err)
					}
					docker := filepath.Join(t.TempDir(), "docker")
					if err := os.WriteFile(docker, []byte("#!/bin/sh\necho '"+mount+"'\n"), 0700); err != nil {
						t.Fatal(err)
					}
					t.Setenv("SAM_DOCKER_CLI_PATH", docker)
					root, err := s.openContextSourceDir(context.Background(), "workspace", &WorkspaceRuntime{}, work, func() {
						if !attack {
							return
						}
						if err := os.Rename(owned, owned+"-pinned"); err != nil {
							t.Fatal(err)
						}
						if err := os.Symlink(outside, owned); err != nil {
							t.Fatal(err)
						}
					})
					if attack {
						if root != nil {
							root.Close()
						}
						if err == nil {
							t.Fatal("working-directory swap escaped trusted base")
						}
						return
					}
					if err != nil {
						t.Fatalf("owner control: %v", err)
					}
					defer root.Close()
					data, err := root.ReadFile("marker")
					if err != nil || string(data) != "OWNER" {
						t.Fatalf("owner control: %q %v", data, err)
					}
				})
			}
		})
	}
}
