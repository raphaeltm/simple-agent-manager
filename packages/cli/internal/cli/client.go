package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

const apiProjectsPath = "/api/projects/"

type APIClient struct {
	config CLIConfig
	http   HTTPDoer
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

func (c APIClient) SubmitTask(ctx context.Context, projectID string, message string, options TaskSubmitOptions) (SubmitTaskResponse, error) {
	body := map[string]any{"message": message}
	addIfSet(body, "agentType", options.Agent)
	addIfSet(body, "agentProfileId", options.AgentProfile)
	addIfSet(body, "contextSummary", options.ContextSummary)
	addIfSet(body, "devcontainerConfigName", options.Devcontainer)
	addIfSet(body, "nodeId", options.Node)
	addIfSet(body, "parentTaskId", options.ParentTask)
	addIfSet(body, "provider", options.Provider)
	addIfSet(body, "taskMode", options.Mode)
	addIfSet(body, "vmLocation", options.VMLocation)
	addIfSet(body, "vmSize", options.VMSize)
	addIfSet(body, "workspaceProfile", options.Workspace)

	var response SubmitTaskResponse
	err := c.request(ctx, http.MethodPost, projectAPIPath(projectID, "tasks", "submit"), body, &response)
	return response, err
}

func (c APIClient) GetTaskStatus(ctx context.Context, projectID string, taskID string) (TaskStatusResponse, error) {
	var response TaskStatusResponse
	err := c.request(ctx, http.MethodGet, projectAPIPath(projectID, "tasks", taskID), nil, &response)
	return response, err
}

func (c APIClient) SendPrompt(ctx context.Context, projectID string, sessionID string, content string) (map[string]any, error) {
	var response map[string]any
	err := c.request(ctx, http.MethodPost, projectAPIPath(projectID, "sessions", sessionID, "prompt"), map[string]any{"content": content}, &response)
	return response, err
}

func projectAPIPath(projectID string, segments ...string) string {
	path := apiProjectsPath + url.PathEscape(projectID)
	for _, segment := range segments {
		path += "/" + url.PathEscape(segment)
	}
	return path
}

func (c APIClient) request(ctx context.Context, method string, path string, body map[string]any, out any) error {
	var reader io.Reader
	if body != nil {
		content, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(content)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.config.APIURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cookie", c.config.SessionCookie)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	response, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	content, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return parseAPIError(response.StatusCode, content)
	}
	if len(content) == 0 {
		return nil
	}
	if err := json.Unmarshal(content, out); err != nil {
		return APIError{Status: response.StatusCode, Code: "INVALID_JSON", Message: "SAM API returned invalid JSON"}
	}
	return nil
}

func parseAPIError(status int, content []byte) error {
	var body struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(content, &body); err != nil {
		body.Message = string(content)
	}
	if body.Error == "" {
		body.Error = "HTTP_ERROR"
	}
	if body.Message == "" {
		body.Message = fmt.Sprintf("SAM API request failed with %d", status)
	}
	return APIError{Status: status, Code: body.Error, Message: body.Message}
}

func addIfSet(body map[string]any, key string, value string) {
	if value != "" {
		body[key] = value
	}
}
