package publish

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sort"
	"strings"
)

const secretInterpolationPlaceholder = "__SAM_CONFIGURED_SECRET_PLACEHOLDER__"

var errUnsupportedComposeVolumes = errors.New("unsupported Docker Compose volumes")

const unsupportedComposeVolumesGuidance = "build_and_publish does not support Docker Compose named or anonymous volumes yet. Compose volumes would be stored as Docker-managed local volumes on the deployment node, not SAM provider-backed deployment volumes. Remove service volume mounts and top-level volumes for now; do not retry this Compose shape for stateful data until build_and_publish supports SAM provider-backed volume rewriting."

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
	Events     EventSink
	Logger     *slog.Logger
}

// composeConfig is the subset of `docker compose config --format json` we read.
type composeConfig struct {
	Name     string                          `json:"name"`
	Services map[string]composeConfigService `json:"services"`
	Volumes  map[string]json.RawMessage     `json:"volumes"`
}

type composeConfigService struct {
	Image   string          `json:"image"`
	Build   json.RawMessage `json:"build"`
	Volumes json.RawMessage `json:"volumes"`
}

type composeConfigServiceVolume struct {
	Type   string `json:"type"`
	Source string `json:"source"`
	Target string `json:"target"`
}

type unsupportedComposeVolumesError struct {
	References []string
}

func (e *unsupportedComposeVolumesError) Error() string {
	return fmt.Sprintf("build: unsupported Docker Compose volumes (%s): %s", strings.Join(e.References, ", "), unsupportedComposeVolumesGuidance)
}

func (e *unsupportedComposeVolumesError) Unwrap() error {
	return errUnsupportedComposeVolumes
}

type commandResult struct {
	Stdout []byte
	Stderr string
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
	if opts.Events != nil {
		opts.Events.Event(ctx, Event{Status: "validating", CurrentStep: "compose_config", EventType: "publish.compose_config.started", Message: "validating compose configuration"})
	}

	templateCfg, err := loadComposeTemplateConfig(ctx, composeCmd, opts.WorkspaceDir)
	if err != nil {
		log.Error("compose template validation failed",
			"composeCmd", composeCmd, "workspaceDir", opts.WorkspaceDir, "error", err)
		return nil, err
	}
	if err := validateNoComposeVolumes(templateCfg); err != nil {
		log.Error("compose template uses unsupported volumes", "error", err)
		if opts.Events != nil {
			opts.Events.Event(ctx, Event{
				Status:       "failed",
				CurrentStep:  "compose_config",
				Level:        "error",
				EventType:    "publish.compose_config.failed",
				Message:      "compose configuration uses unsupported volumes",
				ErrorMessage: err.Error(),
				ErrorCode:    "unsupported_compose_volumes",
				Retryable:    false,
			})
		}
		return nil, err
	}
	if err := validateNoSecretRefsInBuildFields(templateCfg, opts.SecretKeys); err != nil {
		log.Error("compose template uses deployment secrets in build-time fields", "error", err)
		return nil, err
	}

	composeEnv := buildComposeCommandEnv(opts.BuildEnv, opts.SecretKeys)
	cfg, err := loadComposeConfig(ctx, composeCmd, opts.WorkspaceDir, composeEnv)
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
	if opts.Events != nil {
		opts.Events.Event(ctx, Event{Status: "validating", CurrentStep: "compose_config", EventType: "publish.compose_config.completed", Message: "compose configuration validated", Detail: map[string]any{"serviceCount": len(cfg.Services)}})
	}

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
	if opts.Events != nil {
		opts.Events.Event(ctx, Event{Status: "building", CurrentStep: "compose_build", EventType: "publish.build.started", Message: "docker compose build started", Detail: map[string]any{"targetCount": len(targets)}})
	}
	if _, err := runCompose(ctx, composeCmd, opts.WorkspaceDir, composeEnv, "build"); err != nil {
		log.Error("compose build command failed", "composeCmd", composeCmd, "error", err)
		return nil, fmt.Errorf("build: docker compose build: %w", err)
	}
	log.Info("host compose build complete", "serviceCount", len(targets))
	if opts.Events != nil {
		opts.Events.Event(ctx, Event{Status: "building", CurrentStep: "compose_build", EventType: "publish.build.completed", Message: "docker compose build completed", Detail: map[string]any{"targetCount": len(targets)}})
	}

	log.Debug("capturing resolved compose config", "composeCmd", composeCmd)
	composeYAML, err := runCompose(ctx, composeCmd, opts.WorkspaceDir, nil, "config", "--no-interpolate")
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

func loadComposeTemplateConfig(ctx context.Context, composeCmd, dir string) (*composeConfig, error) {
	out, err := runCompose(ctx, composeCmd, dir, nil, "config", "--no-interpolate", "--format", "json")
	if err != nil {
		return nil, fmt.Errorf("build: docker compose config --no-interpolate --format json: %w", err)
	}
	var cfg composeConfig
	if err := json.Unmarshal(out, &cfg); err != nil {
		return nil, fmt.Errorf("build: parse compose template json: %w", err)
	}
	return &cfg, nil
}

func buildComposeCommandEnv(buildEnv map[string]string, secretKeys []string) map[string]string {
	keys := normalizedSecretKeys(secretKeys)
	if len(buildEnv) == 0 && len(keys) == 0 {
		return nil
	}
	env := make(map[string]string, len(buildEnv)+len(keys))
	for key, value := range buildEnv {
		env[key] = value
	}
	// Compose validates the whole file during build commands, including
	// runtime-only environment fields. Secret values are never available here,
	// so configured secret keys get non-sensitive placeholders after the
	// template has rejected their use in image/build fields.
	for _, key := range keys {
		env[key] = secretInterpolationPlaceholder
	}
	return env
}

func validateNoSecretRefsInBuildFields(cfg *composeConfig, secretKeys []string) error {
	keys := normalizedSecretKeys(secretKeys)
	if len(keys) == 0 || cfg == nil {
		return nil
	}
	serviceNames := make([]string, 0, len(cfg.Services))
	for name := range cfg.Services {
		serviceNames = append(serviceNames, name)
	}
	sort.Strings(serviceNames)
	for _, serviceName := range serviceNames {
		svc := cfg.Services[serviceName]
		for _, key := range keys {
			if containsEnvReference(svc.Image, key) {
				return fmt.Errorf("build: service %s image references secret interpolation key %s; deployment secrets cannot be used in build/image fields", serviceName, key)
			}
			if containsEnvReference(string(svc.Build), key) {
				return fmt.Errorf("build: service %s build section references secret interpolation key %s; deployment secrets cannot be used in build fields", serviceName, key)
			}
		}
	}
	return nil
}

func validateNoComposeVolumes(cfg *composeConfig) error {
	if cfg == nil {
		return nil
	}

	refs := make(map[string]bool)
	for name := range cfg.Volumes {
		name = strings.TrimSpace(name)
		if name != "" {
			refs["top-level:"+name] = true
		}
	}

	serviceNames := make([]string, 0, len(cfg.Services))
	for name := range cfg.Services {
		serviceNames = append(serviceNames, name)
	}
	sort.Strings(serviceNames)
	for _, serviceName := range serviceNames {
		serviceRefs, err := unsupportedServiceVolumeReferences(serviceName, cfg.Services[serviceName].Volumes)
		if err != nil {
			return err
		}
		for _, ref := range serviceRefs {
			refs[ref] = true
		}
	}

	if len(refs) == 0 {
		return nil
	}
	references := make([]string, 0, len(refs))
	for ref := range refs {
		references = append(references, ref)
	}
	sort.Strings(references)
	return &unsupportedComposeVolumesError{References: references}
}

func unsupportedServiceVolumeReferences(serviceName string, raw json.RawMessage) ([]string, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, nil
	}

	var entries []composeConfigServiceVolume
	if err := json.Unmarshal(raw, &entries); err != nil {
		var shortEntries []string
		if shortErr := json.Unmarshal(raw, &shortEntries); shortErr != nil {
			return nil, fmt.Errorf("build: parse compose volumes for service %s: %w", serviceName, err)
		}
		refs := make([]string, 0, len(shortEntries))
		for _, spec := range shortEntries {
			if ref, ok := unsupportedShortVolumeReference(serviceName, spec); ok {
				refs = append(refs, ref)
			}
		}
		sort.Strings(refs)
		return refs, nil
	}

	refs := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !isComposeManagedVolume(entry) {
			continue
		}
		source := strings.TrimSpace(entry.Source)
		if source == "" {
			target := strings.TrimSpace(entry.Target)
			if target == "" {
				target = "unknown target"
			}
			source = "anonymous at " + target
		}
		refs = append(refs, serviceName+":"+source)
	}
	sort.Strings(refs)
	return refs, nil
}

func isComposeManagedVolume(entry composeConfigServiceVolume) bool {
	volumeType := strings.ToLower(strings.TrimSpace(entry.Type))
	if volumeType == "volume" {
		return true
	}
	if volumeType != "" {
		return false
	}
	source := strings.TrimSpace(entry.Source)
	if source == "" {
		return strings.TrimSpace(entry.Target) != ""
	}
	return !isLikelyBindMountSource(source)
}

func unsupportedShortVolumeReference(serviceName, spec string) (string, bool) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return "", false
	}
	parts := strings.Split(spec, ":")
	if len(parts) == 1 {
		return serviceName + ":anonymous at " + parts[0], true
	}
	source := strings.TrimSpace(parts[0])
	if source == "" {
		target := strings.TrimSpace(parts[1])
		if target == "" {
			target = "unknown target"
		}
		return serviceName + ":anonymous at " + target, true
	}
	if isLikelyBindMountSource(source) {
		return "", false
	}
	return serviceName + ":" + source, true
}

func isLikelyBindMountSource(source string) bool {
	source = strings.TrimSpace(source)
	return source == "." ||
		source == ".." ||
		strings.HasPrefix(source, "/") ||
		strings.HasPrefix(source, "./") ||
		strings.HasPrefix(source, "../") ||
		strings.HasPrefix(source, "~")
}

// IsUnsupportedComposeVolumesError reports whether err came from Compose volume validation.
func IsUnsupportedComposeVolumesError(err error) bool {
	return errors.Is(err, errUnsupportedComposeVolumes)
}

func normalizedSecretKeys(secretKeys []string) []string {
	seen := make(map[string]bool, len(secretKeys))
	keys := make([]string, 0, len(secretKeys))
	for _, key := range secretKeys {
		key = strings.TrimSpace(key)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func containsEnvReference(value, key string) bool {
	if value == "" || key == "" {
		return false
	}
	for offset := 0; ; {
		idx := strings.Index(value[offset:], "${"+key)
		if idx < 0 {
			break
		}
		end := offset + idx + 2 + len(key)
		if end < len(value) && isComposeBracedReferenceSuffix(value[end]) {
			return true
		}
		offset = end
	}
	for i := 0; i < len(value); i++ {
		if value[i] != '$' || i+1 >= len(value) || value[i+1] == '{' {
			continue
		}
		start := i + 1
		end := start
		for end < len(value) && isEnvIdent(value[end]) {
			end++
		}
		if value[start:end] == key {
			return true
		}
	}
	return false
}

func isComposeBracedReferenceSuffix(ch byte) bool {
	return ch == '}' || ch == ':' || ch == '-' || ch == '?' || ch == '+'
}

func isEnvIdent(ch byte) bool {
	return ch == '_' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
}

func inspectImage(ctx context.Context, image string) (*imageInspect, error) {
	result, err := runCommand(ctx, "", nil, "docker", "image", "inspect", image)
	if err != nil {
		return nil, err
	}
	var inspected []imageInspect
	if err := json.Unmarshal(result.Stdout, &inspected); err != nil {
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
	result, err := runCommand(ctx, dir, env, parts[0], cmdArgs...)
	if err != nil {
		return nil, err
	}
	if missing := missingVariableWarnings(result.Stderr); len(missing) > 0 {
		return nil, fmt.Errorf("%s %s: compose reported missing interpolation variables: %s",
			parts[0], strings.Join(cmdArgs, " "), strings.Join(missing, "; "))
	}
	return result.Stdout, nil
}

func runCommand(ctx context.Context, dir string, env map[string]string, name string, args ...string) (*commandResult, error) {
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
	return &commandResult{Stdout: stdout.Bytes(), Stderr: stderr.String()}, nil
}

func missingVariableWarnings(stderr string) []string {
	lines := strings.Split(stderr, "\n")
	warnings := make([]string, 0)
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		lower := strings.ToLower(trimmed)
		if trimmed == "" {
			continue
		}
		if strings.Contains(lower, "variable is not set") ||
			strings.Contains(lower, "is not set. defaulting to a blank string") {
			warnings = append(warnings, trimmed)
		}
	}
	return warnings
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
