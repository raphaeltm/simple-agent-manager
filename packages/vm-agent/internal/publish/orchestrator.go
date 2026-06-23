// Package publish turns a host-side `docker compose build` artifact into a real
// release. The vm-agent builds the workspace's compose services on the host
// docker daemon, then the orchestrator asks the control plane for server-derived
// R2 artifact upload slots, exports each built image with docker save, uploads
// the archives directly to R2, and submits the captured compose topology plus
// artifact descriptors as a release.
//
// The build node does not receive broad registry credentials in this R2-first
// path. Every artifact key is chosen by the control plane, and every release
// descriptor records byte size and sha256 metadata for deployment-time
// verification.
package publish

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// PushCredentials are the short-lived registry credentials minted by the control
// plane for a single publish. Values are never logged.
type PushCredentials struct {
	Registry  string `json:"registry"`
	Username  string `json:"username"`
	Password  string `json:"password"`
	Namespace string `json:"namespace"` // {accountId}/sam-{projectId}
	ExpiresAt string `json:"expiresAt"`
}

// PushCredentialsRequest is the policy context required to mint registry push
// credentials for a compose-publish release.
type PushCredentialsRequest struct {
	Environment    string `json:"environment"`
	AgentProfileID string `json:"agentProfileId"`
}

// ServiceRelease records one re-pushed service image for the release submission.
type ServiceRelease struct {
	ServiceName         string    `json:"serviceName"`
	RegistryServiceName string    `json:"registryServiceName,omitempty"`
	SourceRef           string    `json:"sourceRef"`
	LocalImageRef       string    `json:"localImageRef,omitempty"`
	PushedRef           string    `json:"pushedRef,omitempty"`
	Digest              string    `json:"digest,omitempty"`
	R2Key               string    `json:"r2Key,omitempty"`
	SizeBytes           int64     `json:"sizeBytes,omitempty"`
	ArchiveSHA256       string    `json:"archiveSha256,omitempty"`
	ArchiveType         string    `json:"archiveType,omitempty"`
	MediaType           string    `json:"mediaType,omitempty"`
	Platform            *Platform `json:"platform,omitempty"`
}

type ArtifactUploadRequest struct {
	Environment    string                 `json:"environment"`
	EnvironmentID  string                 `json:"environmentId"`
	AgentProfileID string                 `json:"agentProfileId"`
	Services       []ArtifactServiceInput `json:"services"`
}

type ArtifactServiceInput struct {
	ServiceName   string    `json:"serviceName"`
	SourceRef     string    `json:"sourceRef"`
	LocalImageRef string    `json:"localImageRef,omitempty"`
	Platform      *Platform `json:"platform,omitempty"`
}

type ArtifactUploadInitResponse struct {
	UploadID string           `json:"uploadId"`
	MaxBytes int64            `json:"maxBytes"`
	Uploads  []ArtifactUpload `json:"uploads"`
}

type ArtifactUpload struct {
	ServiceName   string    `json:"serviceName"`
	SourceRef     string    `json:"sourceRef"`
	LocalImageRef string    `json:"localImageRef"`
	R2Key         string    `json:"r2Key"`
	UploadURL     string    `json:"uploadUrl"`
	ExpiresIn     int64     `json:"expiresIn"`
	MaxBytes      int64     `json:"maxBytes"`
	ArchiveType   string    `json:"archiveType"`
	MediaType     string    `json:"mediaType"`
	Platform      *Platform `json:"platform,omitempty"`
}

type ArtifactCompleteRequest struct {
	Environment    string           `json:"environment"`
	EnvironmentID  string           `json:"environmentId"`
	AgentProfileID string           `json:"agentProfileId"`
	Artifacts      []ServiceRelease `json:"artifacts"`
}

// ReleaseSubmittedBy records the SAM context that initiated a compose-publish
// release. The control plane overwrites user/workspace from the callback token.
type ReleaseSubmittedBy struct {
	UserID         string `json:"userId,omitempty"`
	WorkspaceID    string `json:"workspaceId,omitempty"`
	TaskID         string `json:"taskId,omitempty"`
	AgentProfileID string `json:"agentProfileId,omitempty"`
}

// ReleaseSubmission is the payload sent to the control plane to record a release
// from a host-built compose artifact.
type ReleaseSubmission struct {
	Environment   string              `json:"environment"`
	EnvironmentID string              `json:"environmentId"`
	Reference     string              `json:"reference"`
	ComposeYAML   string              `json:"composeYaml"`
	Services      []ServiceRelease    `json:"services"`
	SubmittedBy   *ReleaseSubmittedBy `json:"submittedBy,omitempty"`
}

// ReleaseResult is the control plane's response to a release submission.
type ReleaseResult struct {
	ReleaseID string `json:"releaseId"`
	Version   int    `json:"version"`
	Status    string `json:"status"`
}

// ControlPlane mints push credentials and submits the captured release.
type ControlPlane interface {
	InitArtifactUploads(ctx context.Context, projectID string, req ArtifactUploadRequest) (*ArtifactUploadInitResponse, error)
	CompleteArtifactUploads(ctx context.Context, projectID string, req ArtifactCompleteRequest) error
	SubmitRelease(ctx context.Context, projectID string, req *ReleaseSubmission) (*ReleaseResult, error)
}

// Docker exports images via the host daemon.
type Docker interface {
	Save(ctx context.Context, source, archivePath string) error
}

// Options configures a new Orchestrator.
type Options struct {
	ControlPlane ControlPlane
	Docker       Docker
	HTTPClient   *http.Client
	Logger       *slog.Logger
}

// Orchestrator drives the post-build publish flow.
type Orchestrator struct {
	controlPlane ControlPlane
	docker       Docker
	httpClient   *http.Client
	log          *slog.Logger
}

// New constructs an Orchestrator. ControlPlane and Docker are required.
func New(opts Options) *Orchestrator {
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	client := opts.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	return &Orchestrator{
		controlPlane: opts.ControlPlane,
		docker:       opts.Docker,
		httpClient:   client,
		log:          log.With("component", "publish-orchestrator"),
	}
}

// Publish uploads host-built images as scoped R2 artifacts and records a release.
func (o *Orchestrator) Publish(ctx context.Context, projectID, environment, environmentID string, art *BuildArtifact, submittedBy *ReleaseSubmittedBy) (*ReleaseResult, error) {
	if art == nil {
		return nil, fmt.Errorf("publish: nil build artifact")
	}
	if projectID == "" {
		return nil, fmt.Errorf("publish: empty projectID")
	}
	if strings.TrimSpace(environment) == "" {
		return nil, fmt.Errorf("publish: empty environment")
	}
	if strings.TrimSpace(environmentID) == "" {
		return nil, fmt.Errorf("publish: empty environmentID")
	}
	agentProfileID := ""
	if submittedBy != nil {
		agentProfileID = strings.TrimSpace(submittedBy.AgentProfileID)
	}
	if agentProfileID == "" {
		return nil, fmt.Errorf("publish: empty agentProfileID")
	}

	o.log.Info("publish started",
		"projectId", projectID,
		"environment", environment,
		"environmentId", environmentID,
		"reference", art.Reference,
		"serviceCount", len(art.Services),
		"composeYamlBytes", len(art.ComposeYAML))

	uploadInit, err := o.controlPlane.InitArtifactUploads(ctx, projectID, ArtifactUploadRequest{
		Environment:    environment,
		EnvironmentID:  environmentID,
		AgentProfileID: agentProfileID,
		Services:       artifactServiceInputs(art.Services),
	})
	if err != nil {
		o.log.Error("init artifact uploads failed", "projectId", projectID, "error", err)
		return nil, fmt.Errorf("publish: init artifact uploads: %w", err)
	}
	o.log.Info("artifact uploads initialized",
		"projectId", projectID,
		"uploadId", uploadInit.UploadID,
		"serviceCount", len(uploadInit.Uploads),
		"maxBytes", uploadInit.MaxBytes)

	services, err := o.exportAndUploadServices(ctx, art, uploadInit)
	if err != nil {
		o.log.Error("upload services failed", "projectId", projectID, "error", err)
		return nil, err
	}
	if err := o.controlPlane.CompleteArtifactUploads(ctx, projectID, ArtifactCompleteRequest{
		Environment:    environment,
		EnvironmentID:  environmentID,
		AgentProfileID: agentProfileID,
		Artifacts:      services,
	}); err != nil {
		return nil, fmt.Errorf("publish: complete artifact uploads: %w", err)
	}

	submission := &ReleaseSubmission{
		Environment:   environment,
		EnvironmentID: environmentID,
		Reference:     art.Reference,
		ComposeYAML:   string(art.ComposeYAML),
		Services:      services,
		SubmittedBy:   submittedBy,
	}

	result, err := o.controlPlane.SubmitRelease(ctx, projectID, submission)
	if err != nil {
		o.log.Error("submit release failed",
			"projectId", projectID,
			"reference", art.Reference,
			"services", len(services),
			"error", err)
		return nil, fmt.Errorf("publish: submit release: %w", err)
	}
	o.log.Info("release recorded",
		"projectId", projectID,
		"releaseId", result.ReleaseID,
		"version", result.Version,
		"status", result.Status,
		"services", len(services))

	return result, nil
}

func artifactServiceInputs(services []BuiltService) []ArtifactServiceInput {
	inputs := make([]ArtifactServiceInput, 0, len(services))
	for _, svc := range services {
		inputs = append(inputs, ArtifactServiceInput{
			ServiceName: svc.ServiceName,
			SourceRef:   svc.LocalRef,
			Platform:    svc.Platform,
		})
	}
	return inputs
}

func (o *Orchestrator) exportAndUploadServices(ctx context.Context, art *BuildArtifact, init *ArtifactUploadInitResponse) ([]ServiceRelease, error) {
	uploadsByService := make(map[string]ArtifactUpload, len(init.Uploads))
	for _, upload := range init.Uploads {
		uploadsByService[upload.ServiceName] = upload
	}
	dir, err := os.MkdirTemp("", "sam-publish-artifacts-*")
	if err != nil {
		return nil, fmt.Errorf("publish: create temp dir: %w", err)
	}
	defer os.RemoveAll(dir)

	releases := make([]ServiceRelease, 0, len(art.Services))
	for i := range art.Services {
		svc := art.Services[i]
		originalServiceName := strings.TrimSpace(svc.ServiceName)
		registryServiceName := serviceSlug(svc, i)
		if originalServiceName == "" {
			originalServiceName = registryServiceName
		}
		upload, ok := uploadsByService[originalServiceName]
		if !ok {
			return nil, fmt.Errorf("publish: missing artifact upload descriptor for service %s", originalServiceName)
		}
		archivePath := filepath.Join(dir, registryServiceName+".tar")

		o.log.Info("exporting service image",
			"service", originalServiceName,
			"source", svc.LocalRef,
			"archivePath", archivePath)

		if err := o.docker.Save(ctx, svc.LocalRef, archivePath); err != nil {
			return nil, fmt.Errorf("publish: save %s: %w", svc.LocalRef, err)
		}
		sizeBytes, archiveSHA, err := fileSizeAndSHA256(archivePath)
		if err != nil {
			return nil, fmt.Errorf("publish: hash %s: %w", archivePath, err)
		}
		maxBytes := upload.MaxBytes
		if maxBytes <= 0 {
			maxBytes = init.MaxBytes
		}
		if maxBytes > 0 && sizeBytes > maxBytes {
			return nil, fmt.Errorf("publish: artifact %s size %d exceeds maximum %d bytes", originalServiceName, sizeBytes, maxBytes)
		}
		if err := o.uploadArchive(ctx, upload.UploadURL, upload.MediaType, archivePath, sizeBytes); err != nil {
			return nil, err
		}
		o.log.Info("service image artifact uploaded",
			"service", originalServiceName,
			"r2Key", upload.R2Key,
			"sizeBytes", sizeBytes,
			"archiveSha256", archiveSHA)

		releases = append(releases, ServiceRelease{
			ServiceName:         originalServiceName,
			RegistryServiceName: registryServiceName,
			SourceRef:           svc.LocalRef,
			LocalImageRef:       upload.LocalImageRef,
			R2Key:               upload.R2Key,
			SizeBytes:           sizeBytes,
			ArchiveSHA256:       archiveSHA,
			ArchiveType:         upload.ArchiveType,
			MediaType:           upload.MediaType,
			Platform:            upload.Platform,
		})
	}
	return releases, nil
}

func fileSizeAndSHA256(path string) (int64, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	hasher := sha256.New()
	size, err := io.Copy(hasher, file)
	if err != nil {
		return 0, "", err
	}
	return size, "sha256:" + hex.EncodeToString(hasher.Sum(nil)), nil
}

func (o *Orchestrator) uploadArchive(ctx context.Context, uploadURL, mediaType, archivePath string, size int64) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return fmt.Errorf("publish: open archive: %w", err)
	}
	defer file.Close()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, uploadURL, file)
	if err != nil {
		return fmt.Errorf("publish: create upload request: %w", err)
	}
	req.ContentLength = size
	if mediaType != "" {
		req.Header.Set("Content-Type", mediaType)
	}
	resp, err := o.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("publish: upload archive: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body := readLimited(resp.Body)
		return fmt.Errorf("publish: upload archive returned %d: %s", resp.StatusCode, body)
	}
	return nil
}

func readLimited(body io.Reader) string {
	data, err := io.ReadAll(io.LimitReader(body, 4096))
	if err != nil {
		return "failed to read response body: " + err.Error()
	}
	return string(data)
}

// targetRef is the project-namespace reference for a re-pushed service image.
// CF registry paths are {registry}/{accountId}/{repository}:{tag}; the namespace
// already carries {accountId}/sam-{projectId}, so each service appends "-{name}".
func targetRef(creds *PushCredentials, serviceName, reference string) string {
	tag := reference
	if tag == "" || IsDigestReference(tag) {
		tag = "latest"
	}
	return fmt.Sprintf("%s/%s-%s:%s", creds.Registry, creds.Namespace, serviceName, tag)
}

// pinnedRef rewrites a tagged ref to a digest-pinned ref for the release record.
func pinnedRef(taggedRef, digest string) string {
	if digest == "" {
		return taggedRef
	}
	if idx := strings.LastIndex(taggedRef, ":"); idx != -1 {
		if slash := strings.LastIndex(taggedRef, "/"); slash < idx {
			return taggedRef[:idx] + "@" + digest
		}
	}
	return taggedRef + "@" + digest
}

// serviceSlug derives a stable, registry-safe service name. It prefers the
// compose service name, then a positional fallback.
func serviceSlug(svc BuiltService, index int) string {
	name := sanitizeServiceName(svc.ServiceName)
	if name == "" {
		name = fmt.Sprintf("service-%d", index)
	}
	return name
}

// sanitizeServiceName lowercases and reduces a name to the registry path charset
// [a-z0-9-], collapsing runs of invalid characters into single hyphens.
func sanitizeServiceName(s string) string {
	var b strings.Builder
	prevHyphen := false
	for _, r := range strings.ToLower(s) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevHyphen = false
		default:
			if !prevHyphen && b.Len() > 0 {
				b.WriteByte('-')
				prevHyphen = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}
