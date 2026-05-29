package cli

import (
	"context"
	"io"
	"net/http"
)

type Runtime struct {
	Args       []string
	Env        ConfigEnv
	HTTPClient HTTPDoer
	Stdin      io.Reader
	Stdout     io.Writer
	Stderr     io.Writer
	Runner     Runner
}

type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

type ConfigEnv interface {
	Getenv(key string) string
	UserHomeDir() (string, error)
}

type Runner interface {
	GOOS() string
	GOARCH() string
	LookPath(file string) (string, error)
	Command(ctx context.Context, name string, args ...string) ([]byte, error)
}

type CLIConfig struct {
	APIURL        string `json:"apiUrl"`
	SessionCookie string `json:"sessionCookie"`
}

type AuthUser struct {
	ID    string `json:"id,omitempty"`
	Email string `json:"email,omitempty"`
	Name  string `json:"name,omitempty"`
}

type TokenLoginResponse struct {
	Success       bool     `json:"success,omitempty"`
	User          AuthUser `json:"user,omitempty"`
	SessionCookie string   `json:"sessionCookie,omitempty"`
}

type DeviceCodeResponse struct {
	DeviceCode              string `json:"deviceCode"`
	UserCode                string `json:"userCode"`
	VerificationURI         string `json:"verificationUri"`
	VerificationURIComplete string `json:"verificationUriComplete"`
	ExpiresIn               int    `json:"expiresIn"`
	Interval                int    `json:"interval"`
}

type SubmitTaskResponse struct {
	TaskID     string `json:"taskId,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
	BranchName string `json:"branchName,omitempty"`
	Status     string `json:"status,omitempty"`
}

type TaskStatusResponse struct {
	ID            string  `json:"id,omitempty"`
	Title         string  `json:"title,omitempty"`
	Status        string  `json:"status,omitempty"`
	ExecutionStep string  `json:"executionStep,omitempty"`
	TaskMode      string  `json:"taskMode,omitempty"`
	OutputBranch  *string `json:"outputBranch,omitempty"`
	OutputPRURL   *string `json:"outputPrUrl,omitempty"`
	OutputSummary *string `json:"outputSummary,omitempty"`
	ErrorMessage  *string `json:"errorMessage,omitempty"`
	FinalizedAt   *string `json:"finalizedAt,omitempty"`
	UpdatedAt     string  `json:"updatedAt,omitempty"`
}

type WorkspaceResponse struct {
	ID     string `json:"id"`
	URL    string `json:"url,omitempty"`
	Status string `json:"status,omitempty"`
	NodeID string `json:"nodeId,omitempty"`
	Name   string `json:"name,omitempty"`
}

type DetectedPort struct {
	Port       int    `json:"port"`
	Address    string `json:"address,omitempty"`
	Label      string `json:"label,omitempty"`
	URL        string `json:"url,omitempty"`
	DetectedAt string `json:"detectedAt,omitempty"`
}

type PortsResponse struct {
	Ports []DetectedPort `json:"ports"`
}

type PortTokenResponse struct {
	Token string `json:"token"`
	URL   string `json:"url"`
	Port  int    `json:"port"`
}

type TaskSubmitOptions struct {
	Agent          string
	AgentProfile   string
	ContextSummary string
	Devcontainer   string
	Mode           string
	Node           string
	ParentTask     string
	Provider       string
	VMLocation     string
	VMSize         string
	Workspace      string
}
