package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const apiProjectsPath = "/api/projects/"
const apiWorkspacesPath = "/api/workspaces/"
const defaultMaxAPIResponseBodyBytes int64 = 1 << 20

type APIClient struct {
	config         CLIConfig
	idempotencyKey string
	http           HTTPDoer
}

type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e APIError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func NewAPIClient(config CLIConfig, httpClient HTTPDoer) APIClient {
	return APIClient{config: config, http: httpClient}
}

func ExchangeAPIToken(ctx context.Context, httpClient HTTPDoer, apiURL string, token string) (TokenLoginResponse, error) {
	var response TokenLoginResponse
	err := postAuthJSON(ctx, httpClient, normalizeAPIURL(apiURL)+"/api/auth/token-login", map[string]any{"token": token}, &response)
	if err != nil {
		return response, err
	}
	if response.SessionCookie == "" {
		return response, APIError{Status: http.StatusOK, Code: "MISSING_SESSION_COOKIE", Message: "SAM API did not return a session cookie"}
	}
	return response, nil
}

func CreateDeviceCode(ctx context.Context, httpClient HTTPDoer, apiURL string) (DeviceCodeResponse, error) {
	var response DeviceCodeResponse
	err := postAuthJSON(ctx, httpClient, normalizeAPIURL(apiURL)+"/api/auth/device/code", nil, &response)
	return response, err
}

func ExchangeDeviceCode(ctx context.Context, httpClient HTTPDoer, apiURL string, deviceCode string) (TokenLoginResponse, error) {
	var response TokenLoginResponse
	err := postAuthJSON(ctx, httpClient, normalizeAPIURL(apiURL)+"/api/auth/device/token", map[string]any{"deviceCode": deviceCode}, &response)
	if err != nil {
		return response, err
	}
	if response.SessionCookie == "" {
		return response, APIError{Status: http.StatusOK, Code: "MISSING_SESSION_COOKIE", Message: "SAM API did not return a session cookie"}
	}
	return response, nil
}

func postAuthJSON(ctx context.Context, httpClient HTTPDoer, endpoint string, body map[string]any, out any) error {
	return doJSON(ctx, httpClient, http.MethodPost, endpoint, "", body, out)
}

func (c APIClient) SubmitTask(ctx context.Context, projectID string, message string, options TaskSubmitOptions) (SubmitTaskResponse, error) {
	body := map[string]any{"message": message}
	if len(options.Attachments) > 0 {
		body["attachments"] = options.Attachments
	}
	addIfSet(body, "agentType", options.Agent)
	addIfSet(body, "agentProfileId", options.AgentProfile)
	addIfSet(body, "skillId", options.Skill)
	addIfSet(body, "contextSummary", options.ContextSummary)
	addIfSet(body, "devcontainerConfigName", options.Devcontainer)
	addIfSet(body, "nodeId", options.Node)
	addIfSet(body, "parentTaskId", options.ParentTask)
	addIfSet(body, "provider", options.Provider)
	addIfSet(body, "taskMode", options.Mode)
	addIfSet(body, "vmLocation", options.VMLocation)
	addIfSet(body, "vmSize", options.VMSize)
	addIfSet(body, "workspaceProfile", options.Workspace)
	if options.Resource != nil {
		body["resourceRequirements"] = options.Resource
	}

	var response SubmitTaskResponse
	err := c.request(ctx, http.MethodPost, projectAPIPath(projectID, "tasks", "submit"), body, &response)
	return response, err
}

func (c APIClient) GetTaskStatus(ctx context.Context, projectID string, taskID string) (TaskStatusResponse, error) {
	var response TaskStatusResponse
	err := c.request(ctx, http.MethodGet, projectAPIPath(projectID, "tasks", taskID), nil, &response)
	return response, err
}

func (c APIClient) GetWorkspace(ctx context.Context, workspaceID string) (WorkspaceResponse, error) {
	var response WorkspaceResponse
	err := c.request(ctx, http.MethodGet, apiWorkspacesPath+url.PathEscape(workspaceID), nil, &response)
	return response, err
}

func (c APIClient) GetWorkspacePorts(ctx context.Context, workspaceID string) (PortsResponse, error) {
	var response PortsResponse
	err := c.request(ctx, http.MethodGet, apiWorkspacesPath+url.PathEscape(workspaceID)+"/ports", nil, &response)
	return response, err
}

func (c APIClient) GetPortToken(ctx context.Context, workspaceID string, port int) (PortTokenResponse, error) {
	var response PortTokenResponse
	path := fmt.Sprintf("%s%s/port-access?port=%d", apiWorkspacesPath, url.PathEscape(workspaceID), port)
	err := c.request(ctx, http.MethodGet, path, nil, &response)
	return response, err
}

func (c APIClient) CreateLocalForwardSession(ctx context.Context, workspaceID string, req LocalForwardSessionRequest) (LocalForwardSessionResponse, error) {
	var response LocalForwardSessionResponse
	path := fmt.Sprintf("%s%s/forwards", apiWorkspacesPath, url.PathEscape(workspaceID))
	err := c.request(ctx, http.MethodPost, path, map[string]any{
		"remotePort":     req.RemotePort,
		"mode":           req.Mode,
		"localAuthority": req.LocalAuthority,
	}, &response)
	return response, err
}

func (c APIClient) SendPrompt(ctx context.Context, projectID string, sessionID string, content string) (map[string]any, error) {
	var response map[string]any
	err := c.request(ctx, http.MethodPost, projectAPIPath(projectID, "sessions", sessionID, "prompt"), map[string]any{"content": content}, &response)
	return response, err
}

func (c APIClient) ListProjects(ctx context.Context) (ProjectListResponse, error) {
	var response ProjectListResponse
	err := c.request(ctx, http.MethodGet, "/api/projects", nil, &response)
	return response, err
}

func (c APIClient) GetProjectDetail(ctx context.Context, projectID string) (ProjectDetail, error) {
	var response ProjectDetail
	var raw map[string]json.RawMessage
	err := c.request(ctx, http.MethodGet, projectAPIPath(projectID), nil, &raw)
	if err == nil {
		b, _ := json.Marshal(raw)
		err = json.Unmarshal(b, &response)
		if summary, ok := raw["summary"]; ok {
			var counts struct {
				ActiveSessionCount   int `json:"activeSessionCount"`
				ActiveWorkspaceCount int `json:"activeWorkspaceCount"`
			}
			if e := json.Unmarshal(summary, &counts); e != nil {
				return response, e
			}
			response.ActiveSessionCount = counts.ActiveSessionCount
			response.ActiveWorkspaceCount = counts.ActiveWorkspaceCount
		}
	}
	return response, err
}

func (c APIClient) ListSessions(ctx context.Context, projectID string) (SessionListResponse, error) {
	var response SessionListResponse
	err := c.request(ctx, http.MethodGet, projectAPIPath(projectID, "sessions"), nil, &response)
	return response, err
}

func (c APIClient) GetSessionDetail(ctx context.Context, projectID string, sessionID string) (SessionDetailResponse, error) {
	var response SessionDetailResponse
	err := c.request(ctx, http.MethodGet, projectAPIPath(projectID, "sessions", sessionID), nil, &response)
	return response, err
}

func (c APIClient) ListIdeas(ctx context.Context, projectID string) (IdeaListResponse, error) {
	var response IdeaListResponse
	err := c.request(ctx, http.MethodGet, projectAPIPath(projectID, "tasks")+"?status=draft", nil, &response)
	return response, err
}

func (c APIClient) ListLibraryFiles(ctx context.Context, projectID string, recursive bool) (LibraryListResponse, error) {
	var response LibraryListResponse
	path := projectAPIPath(projectID, "library")
	if recursive {
		path += "?" + url.Values{"recursive": {"true"}}.Encode()
	}
	err := c.request(ctx, http.MethodGet, path, nil, &response)
	return response, err
}

func (c APIClient) ListKnowledge(ctx context.Context, projectID string) (KnowledgeListResponse, error) {
	var response KnowledgeListResponse
	err := c.request(ctx, http.MethodGet, projectAPIPath(projectID, "knowledge"), nil, &response)
	return response, err
}

func (c APIClient) ListNotifications(ctx context.Context) (NotificationListResponse, error) {
	var response NotificationListResponse
	err := c.request(ctx, http.MethodGet, "/api/notifications", nil, &response)
	return response, err
}

func (c APIClient) ListTriggers(ctx context.Context, projectID string) (TriggerListResponse, error) {
	var response TriggerListResponse
	err := c.request(ctx, http.MethodGet, projectAPIPath(projectID, "triggers"), nil, &response)
	return response, err
}

func (c APIClient) ListProfiles(ctx context.Context, projectID string) (ProfileListResponse, error) {
	var response ProfileListResponse
	err := c.request(ctx, http.MethodGet, projectAPIPath(projectID, "agent-profiles"), nil, &response)
	return response, err
}

func (c APIClient) ListActivity(ctx context.Context, projectID string) (ActivityListResponse, error) {
	var response ActivityListResponse
	err := c.request(ctx, http.MethodGet, projectAPIPath(projectID, "activity"), nil, &response)
	return response, err
}

func (c APIClient) ListNodes(ctx context.Context) (NodeListResponse, error) {
	var nodes []Node
	err := c.request(ctx, http.MethodGet, "/api/nodes", nil, &nodes)
	return NodeListResponse{Nodes: nodes}, err
}

func projectAPIPath(projectID string, segments ...string) string {
	path := apiProjectsPath + url.PathEscape(projectID)
	for _, segment := range segments {
		path += "/" + url.PathEscape(segment)
	}
	return path
}

func (c APIClient) request(ctx context.Context, method string, path string, body map[string]any, out any) error {
	httpClient := c.http
	if c.idempotencyKey != "" {
		httpClient = keyedHTTPDoer{httpClient, c.idempotencyKey}
	}
	return doJSONWithLimit(ctx, httpClient, method, c.config.APIURL+path, c.config.SessionCookie, body, out, c.config.maxAPIResponseBytes())
}

func doJSON(ctx context.Context, httpClient HTTPDoer, method string, endpoint string, cookie string, body map[string]any, out any) error {
	return doJSONWithLimit(ctx, httpClient, method, endpoint, cookie, body, out, defaultMaxAPIResponseBodyBytes)
}

func doJSONWithLimit(ctx context.Context, httpClient HTTPDoer, method string, endpoint string, cookie string, body map[string]any, out any, maxResponseBytes int64) error {
	var reader io.Reader
	if body != nil {
		content, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(content)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	response, err := httpClient.Do(req)
	if err != nil {
		if method == http.MethodGet {
			return APIError{Code: "REQUEST_FAILED", Message: "Read request transport failed or was cancelled"}
		}
		return APIError{Code: "OUTCOME_UNKNOWN", Message: "Request transport failed; a mutating request may have been accepted. Reconcile before retrying."}
	}
	defer response.Body.Close()

	content, truncated, err := readBoundedAPIResponseBody(response.Body, maxResponseBytes)
	if err != nil {
		return unreadableResponse(method, response.StatusCode, "RESPONSE_READ_FAILED")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return parseAPIError(response.StatusCode, content)
	}
	if truncated {
		if method != http.MethodGet {
			return unreadableResponse(method, response.StatusCode, "RESPONSE_TOO_LARGE")
		}
		return APIError{
			Status:  response.StatusCode,
			Code:    "RESPONSE_TOO_LARGE",
			Message: fmt.Sprintf("SAM API response exceeded %d bytes", maxResponseBytes),
		}
	}
	if len(content) == 0 {
		if method != http.MethodGet && response.StatusCode != http.StatusNoContent {
			return unreadableResponse(method, response.StatusCode, "EMPTY_RESPONSE")
		}
		return nil
	}
	if err := json.Unmarshal(content, out); err != nil {
		if method != http.MethodGet {
			return unreadableResponse(method, response.StatusCode, "INVALID_JSON")
		}
		return APIError{
			Status: response.StatusCode,
			Code:   "INVALID_JSON",
			Message: fmt.Sprintf(
				"SAM API returned invalid JSON for %s %s (status %d): %v",
				method,
				safeEndpointPath(endpoint),
				response.StatusCode,
				err,
			),
		}
	}
	return nil
}

func readBoundedAPIResponseBody(body io.Reader, maxResponseBytes int64) ([]byte, bool, error) {
	if maxResponseBytes <= 0 {
		maxResponseBytes = defaultMaxAPIResponseBodyBytes
	}
	content, err := io.ReadAll(io.LimitReader(body, maxResponseBytes+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(content)) <= maxResponseBytes {
		return content, false, nil
	}
	return content[:maxResponseBytes], true, nil
}

func (c CLIConfig) maxAPIResponseBytes() int64 {
	if c.MaxAPIResponseBytes > 0 {
		return c.MaxAPIResponseBytes
	}
	return defaultMaxAPIResponseBodyBytes
}

func safeEndpointPath(endpoint string) string {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return "<invalid-url>"
	}
	if parsed.RawQuery == "" {
		return parsed.EscapedPath()
	}
	query := parsed.Query()
	for key := range query {
		if isSensitiveQueryKey(key) {
			query.Set(key, "REDACTED")
		}
	}
	return parsed.EscapedPath() + "?" + query.Encode()
}

func isSensitiveQueryKey(key string) bool {
	normalized := strings.ToLower(key)
	return strings.Contains(normalized, "token") ||
		strings.Contains(normalized, "cookie") ||
		strings.Contains(normalized, "secret") ||
		strings.Contains(normalized, "session")
}

func parseAPIError(status int, content []byte) error {
	var body struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if len(content) > 0 {
		if err := json.Unmarshal(content, &body); err != nil {
			body.Message = fmt.Sprintf("SAM API returned a non-JSON error (status %d)", status)
		}
	}
	if !safeAPIErrorCode(body.Error) {
		body.Error = "HTTP_ERROR"
	}
	if body.Error == "AUTHENTICATION_REQUIRED" {
		body.Message = "Authentication required"
	} else if body.Message == "" || strings.HasPrefix(body.Message, "SAM API returned a non-JSON error") {
		if body.Message == "" {
			body.Message = fmt.Sprintf("SAM API request failed with %d", status)
		}
	} else {
		body.Message = fmt.Sprintf("SAM API request failed with %d; use the error code to reconcile or correct the request", status)
	}
	return APIError{Status: status, Code: body.Error, Message: body.Message}
}

func addIfSet(body map[string]any, key string, value string) {
	if value != "" {
		body[key] = value
	}
}

type keyedHTTPDoer struct {
	next HTTPDoer
	key  string
}

func (d keyedHTTPDoer) Do(req *http.Request) (*http.Response, error) {
	req.Header.Set("Idempotency-Key", d.key)
	return d.next.Do(req)
}

func (c APIClient) ListAllProjects(ctx context.Context) (ProjectListResponse, error) {
	var result ProjectListResponse
	cursor := ""
	seen := map[string]bool{}
	for {
		var page ProjectListResponse
		path := "/api/projects"
		if cursor != "" {
			path += "?" + url.Values{"cursor": {cursor}}.Encode()
		}
		if err := c.request(ctx, http.MethodGet, path, nil, &page); err != nil {
			return result, err
		}
		result.Projects = append(result.Projects, page.Projects...)
		if page.NextCursor == nil || *page.NextCursor == "" {
			return result, nil
		}
		cursor = *page.NextCursor
		if seen[cursor] || len(page.Projects) == 0 {
			return result, fmt.Errorf("project pagination made no progress")
		}
		seen[cursor] = true
	}
}

func safeAPIErrorCode(code string) bool {
	if len(code) == 0 || len(code) > 64 {
		return false
	}
	for _, c := range code {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func unreadableResponse(method string, status int, code string) error {
	if method != http.MethodGet {
		return APIError{Status: status, Code: "OUTCOME_UNKNOWN", Message: "Response could not be read; a mutating request may have been accepted. Reconcile before retrying."}
	}
	return APIError{Status: status, Code: code, Message: "SAM API response could not be read"}
}
