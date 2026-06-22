package publish

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sort"
	"strings"
)

// BuildOptions configures a host-side compose build.
type BuildOptions struct {
	// WorkspaceDir is the host path of the cloned repo (the compose project
	// root). It is the same directory passed to `devcontainer up`.
	WorkspaceDir string
	// Reference is the release tag the publish targets (e.g. "latest").
	Reference string
	// ComposeCmd is the compose CLI invocation (e.g. "docker compose"). When
	// empty it is auto-detected (v2 "docker compose" preferred, v1
	// "docker-compose" fallback).
	ComposeCmd string
	// BuildEnv is non-secret deployment config supplied to Docker Compose for
	// interpolation during build inventory and build commands.
	BuildEnv map[string]string
	// SecretKeys are deployment config keys that are secret. Values are not
	// available on build nodes; phase-one validation rejects obvious build-field
	// references before running compose.
	SecretKeys []string
	Logger     *slog.Logger
}

// composeConfig is the subset of `docker compose config --format json` we read.
type composeConfig struct {
	Name     string                          `json:"name"`
	Services map[string]composeConfigService `json:"services"`
}

type composeConfigService struct {
	Image string          `json:"image"`
	Build json.RawMessage `json:"build"`
}

// imageInspect is the subset of `docker image inspect` we read.
type imageInspect struct {
	ID           string   `json:"Id"`
	RepoDigests  []string `json:"RepoDigests"`
	Architecture string   `json:"Architecture"`
	OS           string   `json:"Os"`
	Variant      string   `json:"Variant"`
	Size         int64    `json:"Size"`
}

// Build runs `docker compose build` on the host docker daemon from the
// workspace's compose project, then enumerates the built service images. The
// returned BuildArtifact is the input to Orchestrator.Publish.
func Build(ctx context.Context, opts BuildOptions) (*BuildArtifact, error) {
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	log = log.With("component", "publish-build")

	if strings.TrimSpace(opts.WorkspaceDir) == "" {
		return nil, fmt.Errorf("build: workspace dir required")
	}

	composeCmd := strings.TrimSpace(opts.ComposeCmd)
	if composeCmd == "" {
		detected, err := detectComposeCmd(ctx, opts.WorkspaceDir)
		if err != nil {
			return nil, err
		}
		composeCmd = detected
	}
	log.Info("host compose build starting",
		"workspaceDir", opts.WorkspaceDir,
		"composeCmd", composeCmd,
		"reference", opts.Reference)

	cfg, err := loadComposeConfig(ctx, composeCmd, opts.WorkspaceDir, opts.BuildEnv)
	if err != nil {
		// `docker compose config --format json` is the validation gate. If it
		// fails the error wraps the compose CLI stderr (invalid schema,
		// unsupported field, parse error) — log it so the real failure is
		// captured without re-running.
		log.Error("compose config validation failed",
			"composeCmd", composeCmd, "workspaceDir", opts.WorkspaceDir, "error", err)
		return nil, err
	}
	log.Debug("compose config validated",
		"project", cfg.Name, "serviceCount", len(cfg.Services))

	// Only services with a `build` section produce images we re-push. Services
	// without build (e.g. postgres:15) are pulled by the deployment node.
	type buildTarget struct {
		service string
		image   string
	}
	var targets []buildTarget
	// skipped records every service that lacks a build section, with the reason,
	// so a failed build (no targets) can explain itself with hard data instead
	// of a bare error. Sorted names keep the diagnostic stable across runs.
	type skippedService struct {
		service string
		image   string
		reason  string
	}
	var skipped []skippedService
	serviceNames := make([]string, 0, len(cfg.Services))
	for name := range cfg.Services {
		serviceNames = append(serviceNames, name)
	}
	sort.Strings(serviceNames)
	for _, name := range serviceNames {
		svc := cfg.Services[name]
		image := strings.TrimSpace(svc.Image)
		hasBuild := len(svc.Build) > 0 && string(svc.Build) != "null"
		log.Debug("compose service parsed",
			"project", cfg.Name,
			"service", name,
			"image", image,
			"hasBuild", hasBuild)
		if !hasBuild {
			reason := "no build section"
			if image == "" {
				reason = "no build section and no image"
			}
			skipped = append(skipped, skippedService{service: name, image: image, reason: reason})
			continue
		}
		if image == "" {
			// Compose's default generated name when `image:` is omitted.
			image = fmt.Sprintf("%s-%s", cfg.Name, name)
		}
		targets = append(targets, buildTarget{service: name, image: image})
	}
	if len(targets) == 0 {
		// Emit the full service inventory at Error level: this is the single
		// most common real-repo failure (every service is image:/provider:-only
		// with no build section), and the inventory is the hard data needed to
		// diagnose it without re-running.
		inventory := make([]string, 0, len(skipped))
		for _, s := range skipped {
			inventory = append(inventory, fmt.Sprintf("%s(image=%q, %s)", s.service, s.image, s.reason))
		}
		log.Error("compose build has no buildable services",
			"project", cfg.Name,
			"workspaceDir", opts.WorkspaceDir,
			"serviceCount", len(cfg.Services),
			"services", strings.Join(serviceNames, ","),
			"skipped", strings.Join(inventory, "; "))
		return nil, fmt.Errorf(
			"build: no compose services with a build section in %s (services: %s)",
			opts.WorkspaceDir, strings.Join(inventory, "; "))
	}
	// targets is already in deterministic (sorted) order because it is built by
	// iterating the pre-sorted serviceNames slice above.
	log.Debug("compose build targets resolved",
		"project", cfg.Name,
		"targetCount", len(targets),
		"skippedCount", len(skipped))

	log.Debug("running compose build", "composeCmd", composeCmd, "workspaceDir", opts.WorkspaceDir)
	if _, err := runCompose(ctx, composeCmd, opts.WorkspaceDir, opts.BuildEnv, "build"); err != nil {
		log.Error("compose build command failed", "composeCmd", composeCmd, "error", err)
		return nil, fmt.Errorf("build: docker compose build: %w", err)
	}
	log.Info("host compose build complete", "serviceCount", len(targets))

	log.Debug("capturing resolved compose config", "composeCmd", composeCmd)
	composeYAML, err := runCompose(ctx, composeCmd, opts.WorkspaceDir, opts.BuildEnv, "config", "--no-interpolate")
	if err != nil {
		log.Error("compose config command failed", "composeCmd", composeCmd, "error", err)
		return nil, fmt.Errorf("build: docker compose config: %w", err)
	}

	services := make([]BuiltService, 0, len(targets))
	for _, t := range targets {
		built := BuiltService{ServiceName: t.service, LocalRef: t.image}
		inspect, err := inspectImage(ctx, t.image)
		if err != nil {
			log.Warn("image inspect failed; proceeding without metadata",
				"service", t.service, "image", t.image, "error", err)
		} else {
			built.Size = inspect.Size
			if inspect.Architecture != "" || inspect.OS != "" || inspect.Variant != "" {
				built.Platform = &Platform{
					Architecture: inspect.Architecture,
					OS:           inspect.OS,
					Variant:      inspect.Variant,
				}
			}
		}
		services = append(services, built)
	}

	return &BuildArtifact{
		Reference:   opts.Reference,
		ComposeYAML: composeYAML,
		Services:    services,
	}, nil
}

// detectComposeCmd prefers compose v2 ("docker compose") and falls back to v1
// ("docker-compose").
func detectComposeCmd(ctx context.Context, dir string) (string, error) {
	if _, err := runCommand(ctx, dir, nil, "docker", "compose", "version"); err == nil {
		return "docker compose", nil
	}
	if _, err := runCommand(ctx, dir, nil, "docker-compose", "version"); err == nil {
		return "docker-compose", nil
	}
	return "", fmt.Errorf("build: no docker compose (v2) or docker-compose (v1) available")
}

func loadComposeConfig(ctx context.Context, composeCmd, dir string, env map[string]string) (*composeConfig, error) {
	out, err := runCompose(ctx, composeCmd, dir, env, "config", "--format", "json")
	if err != nil {
		return nil, fmt.Errorf("build: docker compose config --format json: %w", err)
	}
	var cfg composeConfig
	if err := json.Unmarshal(out, &cfg); err != nil {
		return nil, fmt.Errorf("build: parse compose config json: %w", err)
	}
	return &cfg, nil
}

func inspectImage(ctx context.Context, image string) (*imageInspect, error) {
	out, err := runCommand(ctx, "", nil, "docker", "image", "inspect", image)
	if err != nil {
		return nil, err
	}
	var inspected []imageInspect
	if err := json.Unmarshal(out, &inspected); err != nil {
		return nil, fmt.Errorf("parse image inspect json: %w", err)
	}
	if len(inspected) == 0 {
		return nil, fmt.Errorf("image inspect %s: empty result", image)
	}
	return &inspected[0], nil
}

// runCompose runs the configured compose CLI (which may be multi-word, e.g.
// "docker compose") with args in dir, returning stdout.
func runCompose(ctx context.Context, composeCmd, dir string, env map[string]string, args ...string) ([]byte, error) {
	parts := strings.Fields(composeCmd)
	if len(parts) == 0 {
		return nil, fmt.Errorf("empty compose command")
	}
	cmdArgs := append(parts[1:], args...)
	return runCommand(ctx, dir, env, parts[0], cmdArgs...)
}

func runCommand(ctx context.Context, dir string, env map[string]string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if len(env) > 0 {
		cmd.Env = mergeEnvForCommand(env)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s %s: %w (stderr: %s)",
			name, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

func mergeEnvForCommand(overrides map[string]string) []string {
	env := make([]string, 0, len(overrides)+len(overrides))
	seen := make(map[string]bool, len(overrides))
	for _, item := range os.Environ() {
		key, _, ok := strings.Cut(item, "=")
		if ok {
			if value, exists := overrides[key]; exists {
				env = append(env, fmt.Sprintf("%s=%s", key, value))
				seen[key] = true
				continue
			}
			seen[key] = true
		}
		env = append(env, item)
	}
	for key, value := range overrides {
		if !seen[key] {
			env = append(env, fmt.Sprintf("%s=%s", key, value))
		}
	}
	return env
}
