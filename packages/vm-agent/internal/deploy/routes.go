package deploy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

func (e *Engine) FetchAndApplyRoutes(ctx context.Context, pendingRevision int64) error {
	payload, err := e.fetchRouteConfig(ctx, pendingRevision)
	if err != nil {
		return fmt.Errorf("fetch route config revision=%d: %w", pendingRevision, err)
	}
	return e.ApplyRoutes(ctx, payload)
}

func (e *Engine) ApplyRoutes(ctx context.Context, payload *RouteConfigPayload) error {
	if !e.applyMu.TryLock() {
		return fmt.Errorf("apply in progress")
	}
	defer e.applyMu.Unlock()

	state, err := e.disk.CurrentState()
	if err != nil {
		return fmt.Errorf("read current release state: %w", err)
	}
	if state == nil || state.Seq <= 0 {
		return fmt.Errorf("no current release for route config")
	}

	e.verifierMu.RLock()
	verifier := e.verifier
	e.verifierMu.RUnlock()
	if verifier == nil {
		return fmt.Errorf("no signature verifier configured — refusing to apply unsigned route config")
	}
	if err := verifier.VerifyRouteConfig(payload, e.cfg.EnvironmentID, e.cfg.NodeID, state.Seq, state.RoutingRevision); err != nil {
		return fmt.Errorf("route config verification failed: %w", err)
	}

	slog.Info("deploy.routes: applying", "revision", payload.RoutingRevision, "currentSeq", state.Seq)
	e.setObserved(ObservedState{
		AppliedSeq:      state.Seq,
		Status:          state.Status,
		RoutingRevision: state.RoutingRevision,
		RoutingStatus:   "applying",
	})

	caddyfile, err := GenerateCaddySnippet(payload.Routes)
	if err != nil {
		return fmt.Errorf("generate Caddyfile: %w", err)
	}
	if err := writeFileAtomic(e.disk.CaddyfilePath(state.Seq), caddyfile, 0644); err != nil {
		return fmt.Errorf("write route Caddyfile: %w", err)
	}
	if err := e.reloadCaddy(ctx, e.disk.CaddyfilePath(state.Seq)); err != nil {
		state.RoutingStatus = "failed"
		state.RoutingError = err.Error()
		if updateErr := e.disk.UpdateState(state); updateErr != nil {
			slog.Warn("deploy.routes: failed to persist routing failure", "revision", payload.RoutingRevision, "error", updateErr)
		}
		e.setObserved(ObservedState{
			AppliedSeq:      state.Seq,
			Status:          state.Status,
			RoutingRevision: state.RoutingRevision,
			RoutingStatus:   "failed",
			RoutingError:    err.Error(),
		})
		return fmt.Errorf("reload Caddy route config: %w", err)
	}

	state.RoutingRevision = payload.RoutingRevision
	state.RoutingStatus = "active"
	state.RoutingError = ""
	if err := e.disk.UpdateState(state); err != nil {
		return fmt.Errorf("persist routing metadata: %w", err)
	}
	e.setObserved(ObservedState{
		AppliedSeq:      state.Seq,
		Status:          state.Status,
		RoutingRevision: state.RoutingRevision,
		RoutingStatus:   state.RoutingStatus,
	})
	slog.Info("deploy.routes: applied", "revision", payload.RoutingRevision, "currentSeq", state.Seq)
	return nil
}

func (e *Engine) fetchRouteConfig(ctx context.Context, revision int64) (*RouteConfigPayload, error) {
	requestURL, err := url.Parse(fmt.Sprintf("%s/api/nodes/%s/deploy-routes",
		strings.TrimRight(e.cfg.ControlPlaneURL, "/"),
		url.PathEscape(e.cfg.NodeID),
	))
	if err != nil {
		return nil, fmt.Errorf("build route config URL: %w", err)
	}
	query := requestURL.Query()
	query.Set("revision", fmt.Sprintf("%d", revision))
	query.Set("environmentId", e.cfg.EnvironmentID)
	requestURL.RawQuery = query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+e.getCallbackToken())

	resp, err := e.cfg.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(body))
	}

	var payload RouteConfigPayload
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode route config payload: %w", err)
	}
	return &payload, nil
}
