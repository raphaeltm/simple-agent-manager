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

	"github.com/workspace/vm-agent/internal/config"
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

// setActiveApplySeq records which release the running apply belongs to, so
// liveness signals emitted from a child process can be addressed to the right
// watchdog. Returns a function restoring the previous value.
func (e *Engine) setActiveApplySeq(seq int64) func() {
	e.activeSeqMu.Lock()
	previous := e.activeSeq
	e.activeSeq = seq
	e.activeSeqMu.Unlock()
	return func() {
		e.activeSeqMu.Lock()
		e.activeSeq = previous
		e.activeSeqMu.Unlock()
	}
}

// composeOutputRetentionBytes resolves the retained-output cap, defaulting when the
// engine was constructed without one (tests, and any caller that does not thread
// the vm-agent config through).
func (e *Engine) composeOutputRetentionBytes() int {
	if e == nil || e.cfg.ComposeOutputRetentionBytes <= 0 {
		return int(config.DefaultComposeOutputRetentionBytes)
	}
	return int(e.cfg.ComposeOutputRetentionBytes)
}

// signalLiveness pokes the apply watchdog without persisting a release event.
func (e *Engine) signalLiveness() {
	if e == nil || e.cfg.ApplyLiveness == nil {
		return
	}
	e.activeSeqMu.RLock()
	seq := e.activeSeq
	e.activeSeqMu.RUnlock()
	if seq <= 0 {
		// Outside an apply (teardown, manual down) there is no watchdog to feed.
		return
	}
	e.cfg.ApplyLiveness(e.cfg.EnvironmentID, seq)
}

// livenessWriter mirrors child output into a bounded TAIL buffer while reporting
// that the process is still producing output. It is the child-process analogue
// of newIdleProgressReader, which does the same for artifact downloads.
//
// Tail, not head: compose prints megabytes of "Pulling fs layer" progress and
// then the actual failure (`no such image`, `unauthorized`, `no space left on
// device`) on the LAST lines. Retaining the first N bytes would discard exactly
// the diagnostic this buffer exists to preserve.
//
// os/exec serializes writes to cmd.Stderr on one copier goroutine and Cmd.Wait
// blocks until that goroutine finishes, so neither the buffer nor reads after
// cmd.Run returns need additional locking.
type livenessWriter struct {
	buf    bytes.Buffer
	signal func()
	// limit caps retained output. The liveness signal keeps firing past the cap,
	// so a very chatty pull cannot be killed as "stalled" merely because its
	// output stopped being recorded.
	limit int
	// redactionOverlap retains enough bytes before the returned tail for redaction
	// to see secrets that straddle the retention boundary.
	redactionOverlap int
}

func (w *livenessWriter) Write(p []byte) (int, error) {
	w.buf.Write(p)
	// Amortized compaction: let the buffer reach 2x the cap before trimming, so a
	// multi-megabyte pull costs O(total) copying rather than O(total x limit).
	if w.limit > 0 && w.buf.Len() > 2*w.retainedLimit() {
		w.compact()
	}
	if w.signal != nil {
		w.signal()
	}
	return len(p), nil
}

func (w *livenessWriter) retainedLimit() int {
	if w.limit <= 0 {
		return 0
	}
	if w.redactionOverlap <= 0 {
		return w.limit
	}
	return w.limit + w.redactionOverlap
}

// compact discards all but the trailing retained bytes.
func (w *livenessWriter) compact() {
	retainedLimit := w.retainedLimit()
	if retainedLimit <= 0 || w.buf.Len() <= retainedLimit {
		return
	}
	b := w.buf.Bytes()
	tail := append([]byte(nil), b[len(b)-retainedLimit:]...)
	w.buf.Reset()
	w.buf.Write(tail)
}

// String returns at most `limit` trailing bytes of the child's output.
func (w *livenessWriter) String() string {
	w.compact()
	return tailString(w.buf.String(), w.limit)
}

func (w *livenessWriter) RedactedString(redactor envRedactor) string {
	w.compact()
	return tailString(redactor.redact(w.buf.String()), w.limit)
}

func tailString(value string, limit int) string {
	if limit > 0 && len(value) > limit {
		return value[len(value)-limit:]
	}
	return value
}

func (e *Engine) runCompose(ctx context.Context, composeFile string, interpolationEnv map[string]string, args ...string) error {
	parts := strings.Fields(e.cfg.ComposeCmd)
	cmdArgs := append(parts[1:], "--project-name", e.cfg.ComposeProjectName, "-f", composeFile)
	cmdArgs = append(cmdArgs, args...)

	cmd := exec.CommandContext(ctx, parts[0], cmdArgs...)
	cmd.Env = mergeEnv(os.Environ(), interpolationEnv)
	redactor := newEnvRedactor(interpolationEnv)
	// Compose streams pull/extract progress to stderr. Treat every write as proof
	// of life so a slow-but-progressing pull is not mistaken for a hung apply.
	stderr := &livenessWriter{
		signal:           e.signalLiveness,
		limit:            e.composeOutputRetentionBytes(),
		redactionOverlap: redactor.maxValueLen(),
	}
	cmd.Stderr = stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w (stderr: %s)",
			e.cfg.ComposeCmd, strings.Join(args, " "), err, stderr.RedactedString(redactor))
	}
	if argsContainConfig(args) && composeStderrHasMissingVar(stderr.String()) {
		return fmt.Errorf("compose config reported missing interpolation variables: %s", stderr.RedactedString(redactor))
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
