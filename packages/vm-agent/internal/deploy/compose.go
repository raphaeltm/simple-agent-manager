package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
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
			return fmt.Errorf("health check timed out after %s", e.cfg.HealthTimeout)
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
		return nil, fmt.Errorf("compose ps: %w (stderr: %s)", err, redactor.redact(stderr.String()))
	}

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
			slog.Debug("deploy.inspect: failed to parse container JSON", "line", line, "error", err)
			continue
		}
		services = append(services, ServiceState{
			Name:    container.Name,
			Service: container.Service,
			Status:  container.State,
			Health:  container.Health,
		})
	}
	return services, nil
}
