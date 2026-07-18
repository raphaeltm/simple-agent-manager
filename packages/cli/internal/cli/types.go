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
	APIURL              string `json:"apiUrl"`
	SessionCookie       string `json:"sessionCookie"`
	ActiveProjectID     string `json:"activeProjectId,omitempty"`
	ActiveProjectName   string `json:"activeProjectName,omitempty"`
	MaxAPIResponseBytes int64  `json:"maxApiResponseBytes,omitempty"`
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

type LocalForwardSessionRequest struct {
	RemotePort     int    `json:"remotePort"`
	Mode           string `json:"mode"`
	LocalAuthority string `json:"localAuthority"`
}

type LocalForwardSessionResponse struct {
	Token          string `json:"token"`
	ExpiresAt      string `json:"expiresAt"`
	WorkspaceID    string `json:"workspaceId"`
	NodeID         string `json:"nodeId"`
	RemotePort     int    `json:"remotePort"`
	Mode           string `json:"mode"`
	LocalAuthority string `json:"localAuthority"`
	ForwardPath    string `json:"forwardPath"`
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

// Project represents a project in list responses.
type Project struct {
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	Repository           string `json:"repository,omitempty"`
	RepoProvider         string `json:"repoProvider,omitempty"`
	Status               string `json:"status,omitempty"`
	LastActivityAt       any    `json:"lastActivityAt,omitempty"`
	ActiveSessionCount   int    `json:"activeSessionCount,omitempty"`
	ActiveWorkspaceCount int    `json:"activeWorkspaceCount,omitempty"`
}

// ProjectListResponse wraps a list of projects.
type ProjectListResponse struct {
	Projects []Project `json:"projects"`
}

// ProjectDetail contains full project information.
type ProjectDetail struct {
	ID                   string    `json:"id"`
	Name                 string    `json:"name"`
	Repository           string    `json:"repository,omitempty"`
	RepoProvider         string    `json:"repoProvider,omitempty"`
	Status               string    `json:"status,omitempty"`
	DefaultBranch        string    `json:"defaultBranch,omitempty"`
	LastActivityAt       any       `json:"lastActivityAt,omitempty"`
	ActiveSessionCount   int       `json:"activeSessionCount,omitempty"`
	ActiveWorkspaceCount int       `json:"activeWorkspaceCount,omitempty"`
	RecentSessions       []Session `json:"recentSessions,omitempty"`
}

// Session represents a chat session.
type Session struct {
	ID            string  `json:"id"`
	Topic         string  `json:"topic,omitempty"`
	Status        string  `json:"status,omitempty"`
	MessageCount  int     `json:"messageCount,omitempty"`
	StartedAt     any     `json:"startedAt,omitempty"`
	LastMessageAt any     `json:"lastMessageAt,omitempty"`
	Attention     *string `json:"attention,omitempty"`
	TaskID        string  `json:"taskId,omitempty"`
}

// SessionListResponse wraps a list of sessions.
type SessionListResponse struct {
	Sessions []Session `json:"sessions"`
}

// Message represents a chat message.
type Message struct {
	ID        string `json:"id"`
	Role      string `json:"role,omitempty"`
	Content   string `json:"content,omitempty"`
	CreatedAt any    `json:"createdAt,omitempty"`
}

type SessionDetailResponse struct {
	Session  Session        `json:"session"`
	Messages []Message      `json:"messages"`
	HasMore  bool           `json:"hasMore"`
	State    map[string]any `json:"state,omitempty"`
}

// Idea represents a draft task (idea).
type Idea struct {
	ID        string `json:"id"`
	Title     string `json:"title,omitempty"`
	Status    string `json:"status,omitempty"`
	Priority  int    `json:"priority,omitempty"`
	CreatedAt any    `json:"createdAt,omitempty"`
	UpdatedAt any    `json:"updatedAt,omitempty"`
}

// IdeaListResponse wraps a list of ideas.
type IdeaListResponse struct {
	Tasks []Idea `json:"tasks"`
}

// LibraryFile represents a file in the project library.
type LibraryFile struct {
	ID           string `json:"id"`
	Filename     string `json:"filename,omitempty"`
	Directory    string `json:"directory,omitempty"`
	SizeBytes    int64  `json:"sizeBytes,omitempty"`
	UploadSource string `json:"uploadSource,omitempty"`
	Status       string `json:"status,omitempty"`
	CreatedAt    any    `json:"createdAt,omitempty"`
	UpdatedAt    any    `json:"updatedAt,omitempty"`
}

// LibraryListResponse wraps a list of library files.
type LibraryListResponse struct {
	Files  []LibraryFile `json:"files"`
	Cursor *string       `json:"cursor,omitempty"`
	Total  int           `json:"total,omitempty"`
}

// KnowledgeEntity represents a knowledge graph entity.
type KnowledgeEntity struct {
	ID               string `json:"id,omitempty"`
	Name             string `json:"name"`
	EntityType       string `json:"entityType,omitempty"`
	ObservationCount int    `json:"observationCount,omitempty"`
	CreatedAt        any    `json:"createdAt,omitempty"`
	UpdatedAt        any    `json:"updatedAt,omitempty"`
}

// KnowledgeListResponse wraps a list of knowledge entities.
type KnowledgeListResponse struct {
	Entities []KnowledgeEntity `json:"entities"`
}

// Notification represents a user notification.
type Notification struct {
	ID          string  `json:"id"`
	Type        string  `json:"type,omitempty"`
	Title       string  `json:"title,omitempty"`
	Read        bool    `json:"read,omitempty"`
	ReadAt      *string `json:"readAt,omitempty"`
	DismissedAt *string `json:"dismissedAt,omitempty"`
	CreatedAt   any     `json:"createdAt,omitempty"`
}

// NotificationListResponse wraps a list of notifications.
type NotificationListResponse struct {
	Notifications []Notification `json:"notifications"`
	UnreadCount   int            `json:"unreadCount,omitempty"`
	NextCursor    *string        `json:"nextCursor,omitempty"`
}

// Trigger represents a project trigger.
type Trigger struct {
	ID                string  `json:"id"`
	Name              string  `json:"name,omitempty"`
	Status            string  `json:"status,omitempty"`
	SourceType        string  `json:"sourceType,omitempty"`
	CronExpression    *string `json:"cronExpression,omitempty"`
	CronHumanReadable string  `json:"cronHumanReadable,omitempty"`
	NextFireAt        any     `json:"nextFireAt,omitempty"`
}

// TriggerListResponse wraps a list of triggers.
type TriggerListResponse struct {
	Triggers []Trigger `json:"triggers"`
}

// AgentProfile represents an agent profile.
type AgentProfile struct {
	ID             string `json:"id"`
	Name           string `json:"name,omitempty"`
	AgentType      string `json:"agentType,omitempty"`
	VMSize         string `json:"vmSize,omitempty"`
	VMSizeOverride string `json:"vmSizeOverride,omitempty"`
	TaskMode       string `json:"taskMode,omitempty"`
}

// ProfileListResponse wraps a list of agent profiles.
type ProfileListResponse struct {
	Items []AgentProfile `json:"items"`
}

// ActivityEvent represents a project activity event.
type ActivityEvent struct {
	ID        string         `json:"id"`
	EventType string         `json:"eventType,omitempty"`
	Payload   map[string]any `json:"payload,omitempty"`
	CreatedAt any            `json:"createdAt,omitempty"`
}

// ActivityListResponse wraps a list of activity events.
type ActivityListResponse struct {
	Events []ActivityEvent `json:"events"`
}

// Node represents an infrastructure node.
type Node struct {
	ID            string `json:"id"`
	Name          string `json:"name,omitempty"`
	CloudProvider string `json:"cloudProvider,omitempty"`
	VMSize        string `json:"vmSize,omitempty"`
	VMLocation    string `json:"vmLocation,omitempty"`
	Status        string `json:"status,omitempty"`
	HealthStatus  string `json:"healthStatus,omitempty"`
	IPAddress     string `json:"ipAddress,omitempty"`
}

// NodeListResponse wraps a list of nodes.
type NodeListResponse struct {
	Nodes []Node `json:"nodes"`
}
