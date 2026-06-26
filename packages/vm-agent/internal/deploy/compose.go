package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"
)

func (e *Engine) composeConfigPreflight(ctx context.Context, composeFile string, interpolationEnv map[string]string) error {
	return e.runCompose(ctx, composeFile, interpolationEnv, "config", "-q")
}

func (e *Engine) composePull(ctx context.Context, composeFile string, interpolationEnv map[string]string) error {
	return e.runCompose(ctx, composeFile, interpolationEnv, "pull")
}

func (e *Engine) composeUp(ctx context.Context, composeFile string, interpolationEnv map[string]string) error {
	return e.runCompose(ctx, composeFile, interpolationEnv, "up", "-d", "--remove-orphans")
}

func (e *Engine) composeDown(ctx context.Context, composeFile string, interpolationEnv map[string]string) error {
	return e.runCompose(ctx, composeFile, interpolationEnv, "down")
}

func (e *Engine) cleanupComposeProjectByLabel(ctx context.Context) error {
	dockerCmd := e.composeBinary()
	containers, err := exec.CommandContext(ctx, dockerCmd, "ps", "-aq", "--filter", "label=com.docker.compose.project="+e.cfg.ComposeProjectName).Output()
	if err != nil {
		return fmt.Errorf("list compose project containers: %w", err)
	}
	ids := strings.Fields(string(containers))
	if len(ids) > 0 {
		args := append([]string{"rm", "-f"}, ids...)
		if err := exec.CommandContext(ctx, dockerCmd, args...).Run(); err != nil {
			return fmt.Errorf("remove compose project containers: %w", err)
		}
	}
	_ = exec.CommandContext(ctx, dockerCmd, "network", "rm", e.cfg.ComposeProjectName+"_default").Run()
	return nil
}

func (e *Engine) composeBinary() string {
	parts := strings.Fields(e.cfg.ComposeCmd)
	if len(parts) == 0 {
		return "docker"
	}
	return parts[0]
}

func (e *Engine) runCompose(ctx context.Context, composeFile string, interpolationEnv map[string]string, args ...string) error {
	parts := strings.Fields(e.cfg.ComposeCmd)
	cmdArgs := append(parts[1:], "--project-name", e.cfg.ComposeProjectName, "-f", composeFile)
	cmdArgs = append(cmdArgs, args...)

	cmd := exec.CommandContext(ctx, parts[0], cmdArgs...)
	cmd.Env = mergeEnv(os.Environ(), interpolationEnv)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	redactor := newEnvRedactor(interpolationEnv)

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w (stderr: %s)",
			e.cfg.ComposeCmd, strings.Join(args, " "), err, redactor.redact(stderr.String()))
	}
	if argsContainConfig(args) && composeStderrHasMissingVar(stderr.String()) {
		return fmt.Errorf("compose config reported missing interpolation variables: %s", redactor.redact(stderr.String()))
	}
	return nil
}

func (e *Engine) waitForHealth(ctx context.Context, seq int64, routes []RouteTarget, interpolationEnv map[string]string) error {
	requiredServices := routeServiceSet(routes)
	if len(requiredServices) == 0 {
		return nil
	}

	deadline := time.NewTimer(e.cfg.HealthTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(e.cfg.HealthPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return e.healthTimeoutError(ctx, seq, requiredServices, interpolationEnv)
		case <-ticker.C:
			services, err := e.inspectServices(ctx, seq, interpolationEnv)
			if err != nil {
				slog.Debug("deploy.health: inspect failed", "error", err)
				continue
			}

			if routedServicesHealthy(services, requiredServices) {
				return nil
			}
		}
	}
}

type serviceHealthSnapshot struct {
	Service string `json:"service"`
	Name    string `json:"name,omitempty"`
	State   string `json:"state"`
	Health  string `json:"health"`
}

type healthTimeoutError struct {
	timeout           time.Duration
	unhealthyServices []string
	services          []ServiceState
	inspectErr        error
}

func (e *healthTimeoutError) Error() string {
	if len(e.unhealthyServices) == 0 {
		if e.inspectErr != nil {
			return fmt.Sprintf("health check timed out after %s; final inspect failed: %v", e.timeout, e.inspectErr)
		}
		return fmt.Sprintf("health check timed out after %s", e.timeout)
	}
	return fmt.Sprintf("health check timed out after %s; unhealthy routed services: %s", e.timeout, strings.Join(e.unhealthyServices, ", "))
}

func (e *healthTimeoutError) Unwrap() error {
	return e.inspectErr
}

func (e *healthTimeoutError) Services() []ServiceState {
	return append([]ServiceState(nil), e.services...)
}

func (e *Engine) healthTimeoutError(ctx context.Context, seq int64, requiredServices map[string]bool, interpolationEnv map[string]string) error {
	redactor := newEnvRedactor(interpolationEnv)
	redactedRequiredServices := redactStrings(sortedMapKeys(requiredServices), redactor)
	services, raw, err := e.inspectServicesWithRaw(ctx, seq, interpolationEnv)
	if err != nil {
		slog.Warn("deploy.health: final inspect failed after timeout",
			"seq", seq,
			"requiredServices", redactedRequiredServices,
			"error", err)
		return &healthTimeoutError{
			timeout:           e.cfg.HealthTimeout,
			unhealthyServices: redactedRequiredServices,
			inspectErr:        err,
		}
	}

	snapshots, unhealthy := routedServiceHealthDiagnostics(services, requiredServices)
	redactedSnapshots := redactServiceHealthSnapshots(snapshots, redactor)
	redactedUnhealthy := redactStrings(unhealthy, redactor)
	redactedServices := redactServiceStates(services, redactor)
	slog.Warn("deploy.health: timed out waiting for routed services",
		"seq", seq,
		"requiredServices", redactedRequiredServices,
		"unhealthyServices", redactedUnhealthy,
		"services", redactedSnapshots)
	slog.Warn("deploy.health: final docker compose ps output",
		"seq", seq,
		"output", raw)

	return &healthTimeoutError{
		timeout:           e.cfg.HealthTimeout,
		unhealthyServices: redactedUnhealthy,
		services:          redactedServices,
	}
}

func redactServiceStates(services []ServiceState, redactor envRedactor) []ServiceState {
	redacted := make([]ServiceState, 0, len(services))
	for _, service := range services {
		service.Name = redactor.redact(service.Name)
		service.Service = redactor.redact(service.Service)
		service.Status = redactor.redact(service.Status)
		service.Health = redactor.redact(service.Health)
		redacted = append(redacted, service)
	}
	return redacted
}

func redactServiceHealthSnapshots(snapshots []serviceHealthSnapshot, redactor envRedactor) []serviceHealthSnapshot {
	redacted := make([]serviceHealthSnapshot, 0, len(snapshots))
	for _, snapshot := range snapshots {
		snapshot.Service = redactor.redact(snapshot.Service)
		snapshot.Name = redactor.redact(snapshot.Name)
		snapshot.State = redactor.redact(snapshot.State)
		snapshot.Health = redactor.redact(snapshot.Health)
		redacted = append(redacted, snapshot)
	}
	return redacted
}

func redactStrings(values []string, redactor envRedactor) []string {
	redacted := make([]string, 0, len(values))
	for _, value := range values {
		redacted = append(redacted, redactor.redact(value))
	}
	return redacted
}

func routeServiceSet(routes []RouteTarget) map[string]bool {
	services := make(map[string]bool)
	for _, route := range routes {
		service := strings.TrimSpace(route.Service)
		if service != "" {
			services[service] = true
		}
	}
	return services
}

func routedServicesHealthy(services []ServiceState, requiredServices map[string]bool) bool {
	healthyByService := make(map[string]bool, len(requiredServices))
	for _, svc := range services {
		service, ok := matchedService(svc, requiredServices)
		if ok && serviceHealthy(svc) {
			healthyByService[service] = true
		}
	}
	for service := range requiredServices {
		if !healthyByService[service] {
			return false
		}
	}
	return true
}

func routedServiceHealthDiagnostics(services []ServiceState, requiredServices map[string]bool) ([]serviceHealthSnapshot, []string) {
	snapshotByService := make(map[string]serviceHealthSnapshot, len(requiredServices))
	healthyByService := make(map[string]bool, len(requiredServices))
	for _, svc := range services {
		service, ok := matchedService(svc, requiredServices)
		if !ok {
			continue
		}
		snapshotByService[service] = serviceHealthSnapshot{
			Service: service,
			Name:    svc.Name,
			State:   svc.Status,
			Health:  svc.Health,
		}
		if serviceHealthy(svc) {
			healthyByService[service] = true
		}
	}

	required := sortedMapKeys(requiredServices)
	snapshots := make([]serviceHealthSnapshot, 0, len(required))
	var unhealthy []string
	for _, service := range required {
		snapshot, ok := snapshotByService[service]
		if !ok {
			snapshot = serviceHealthSnapshot{
				Service: service,
				State:   "missing",
				Health:  "missing",
			}
		}
		snapshots = append(snapshots, snapshot)
		if !healthyByService[service] {
			unhealthy = append(unhealthy, fmt.Sprintf("%s (state=%s health=%s)", service, snapshot.State, snapshot.Health))
		}
	}
	return snapshots, unhealthy
}

func sortedMapKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

func matchedService(svc ServiceState, requiredServices map[string]bool) (string, bool) {
	if requiredServices[svc.Service] {
		return svc.Service, true
	}
	if requiredServices[svc.Name] {
		return svc.Name, true
	}
	return "", false
}

func serviceHealthy(svc ServiceState) bool {
	if svc.Status != "running" {
		return false
	}
	return svc.Health == "" || svc.Health == "healthy" || svc.Health == "none"
}

func (e *Engine) inspectServices(ctx context.Context, seq int64, interpolationEnv map[string]string) ([]ServiceState, error) {
	services, _, err := e.inspectServicesWithRaw(ctx, seq, interpolationEnv)
	return services, err
}

func (e *Engine) inspectServicesWithRaw(ctx context.Context, seq int64, interpolationEnv map[string]string) ([]ServiceState, string, error) {
	composeFile := e.disk.ComposeFilePath(seq)

	parts := strings.Fields(e.cfg.ComposeCmd)
	cmdArgs := append(parts[1:], "--project-name", e.cfg.ComposeProjectName, "-f", composeFile, "ps", "--format", "json")

	cmd := exec.CommandContext(ctx, parts[0], cmdArgs...)
	cmd.Env = mergeEnv(os.Environ(), interpolationEnv)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	redactor := newEnvRedactor(interpolationEnv)

	if err := cmd.Run(); err != nil {
		return nil, "", fmt.Errorf("compose ps: %w (stderr: %s)", err, redactor.redact(stderr.String()))
	}

	raw := redactor.redact(stdout.String())
	var services []ServiceState
	for _, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		if line == "" {
			continue
		}
		var container struct {
			Name    string `json:"Name"`
			Service string `json:"Service"`
			State   string `json:"State"`
			Health  string `json:"Health"`
		}
		if err := json.Unmarshal([]byte(line), &container); err != nil {
			slog.Debug("deploy.inspect: failed to parse container JSON", "line", redactor.redact(line), "error", err)
			continue
		}
		services = append(services, ServiceState{
			Name:    container.Name,
			Service: container.Service,
			Status:  container.State,
			Health:  container.Health,
		})
	}
	return services, raw, nil
}
