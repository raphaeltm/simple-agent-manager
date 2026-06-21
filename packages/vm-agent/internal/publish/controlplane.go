package publish

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
)

// Control-plane routes the publish orchestrator calls. Both are project-scoped
// and authenticated with the workspace's callback JWT.
const (
	// routeMintPushCredentials mints short-lived scoped registry push creds.
	routeMintPushCredentials = "/registry-push-credentials"
	// routeComposePublishRelease records a release from a captured compose publish.
	routeComposePublishRelease = "/compose-publish-release"
)

const maxControlPlaneErrorBodyBytes = 4096

// HTTPControlPlane talks to the SAM control plane over HTTP using the workspace
// callback JWT. It is the production ControlPlane implementation.
type HTTPControlPlane struct {
	baseURL string
	token   string
	client  *http.Client
	log     *slog.Logger
}

// HTTPControlPlaneOptions configures a new HTTPControlPlane. BaseURL, Token, and
// Client are required.
type HTTPControlPlaneOptions struct {
	BaseURL string
	Token   string
	Client  *http.Client
	Logger  *slog.Logger
}

// NewHTTPControlPlane constructs an HTTPControlPlane.
func NewHTTPControlPlane(opts HTTPControlPlaneOptions) *HTTPControlPlane {
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	client := opts.Client
	if client == nil {
		client = http.DefaultClient
	}
	return &HTTPControlPlane{
		baseURL: strings.TrimRight(opts.BaseURL, "/"),
		token:   opts.Token,
		client:  client,
		log:     log.With("component", "publish-controlplane"),
	}
}

// MintPushCredentials requests short-lived scoped registry push credentials for
// the project. The returned credential values are never logged.
func (c *HTTPControlPlane) MintPushCredentials(ctx context.Context, projectID string, req PushCredentialsRequest) (*PushCredentials, error) {
	var creds PushCredentials
	if err := c.do(ctx, projectID, routeMintPushCredentials, req, &creds); err != nil {
		return nil, err
	}
	if creds.Registry == "" || creds.Namespace == "" {
		return nil, fmt.Errorf("mint push credentials: control plane returned incomplete credentials")
	}
	return &creds, nil
}

// SubmitRelease records a release from the captured compose publish.
func (c *HTTPControlPlane) SubmitRelease(ctx context.Context, projectID string, req *ReleaseSubmission) (*ReleaseResult, error) {
	var result ReleaseResult
	if err := c.do(ctx, projectID, routeComposePublishRelease, req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// do performs a project-scoped POST with the callback JWT, JSON-encoding reqBody
// (if non-nil) and decoding the response into out.
func (c *HTTPControlPlane) do(ctx context.Context, projectID, route string, reqBody, out any) error {
	url := c.baseURL + "/api/projects/" + projectID + route

	var bodyReader io.Reader
	if reqBody != nil {
		raw, err := json.Marshal(reqBody)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bodyReader)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("request %s: %w", route, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		body := readControlPlaneErrorBody(resp.Body)
		return fmt.Errorf("control plane %s returned %d: %s", route, resp.StatusCode, body)
	}

	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode response %s: %w", route, err)
	}
	return nil
}

func readControlPlaneErrorBody(body io.Reader) string {
	if body == nil {
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(body, maxControlPlaneErrorBodyBytes+1))
	if err != nil {
		return "failed to read response body: " + err.Error()
	}
	if len(data) > maxControlPlaneErrorBodyBytes {
		return string(data[:maxControlPlaneErrorBodyBytes]) + "...[truncated]"
	}
	return string(data)
}
