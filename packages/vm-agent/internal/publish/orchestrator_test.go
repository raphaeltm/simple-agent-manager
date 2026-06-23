package publish

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// fakeControlPlane records artifact/submit calls and returns canned responses.
type fakeControlPlane struct {
	initResp      *ArtifactUploadInitResponse
	initErr       error
	initCalls     int
	initProject   string
	initRequest   ArtifactUploadRequest
	completeErr   error
	completed     *ArtifactCompleteRequest
	submitErr     error
	submitted     *ReleaseSubmission
	submittedProj string
	result        *ReleaseResult
}

func (f *fakeControlPlane) InitArtifactUploads(_ context.Context, projectID string, req ArtifactUploadRequest) (*ArtifactUploadInitResponse, error) {
	f.initCalls++
	f.initProject = projectID
	f.initRequest = req
	if f.initErr != nil {
		return nil, f.initErr
	}
	return f.initResp, nil
}

func (f *fakeControlPlane) CompleteArtifactUploads(_ context.Context, _ string, req ArtifactCompleteRequest) error {
	f.completed = &req
	return f.completeErr
}

func (f *fakeControlPlane) SubmitRelease(_ context.Context, projectID string, req *ReleaseSubmission) (*ReleaseResult, error) {
	if f.submitErr != nil {
		return nil, f.submitErr
	}
	f.submittedProj = projectID
	f.submitted = req
	return f.result, nil
}

// fakeDocker records saves and writes deterministic archive content.
type fakeDocker struct {
	saves   [][2]string
	saveErr error
}

func (d *fakeDocker) Save(_ context.Context, source, archivePath string) error {
	if d.saveErr != nil {
		return d.saveErr
	}
	d.saves = append(d.saves, [2]string{source, archivePath})
	return os.WriteFile(archivePath, []byte("archive:"+source), 0644)
}

func artifactUploadServer(t *testing.T) (*httptest.Server, *[]string) {
	t.Helper()
	uploads := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("method = %s, want PUT", r.Method)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read upload: %v", err)
		}
		uploads = append(uploads, string(body))
		w.WriteHeader(http.StatusOK)
	}))
	return server, &uploads
}

func sampleUploadInit(uploadURL string) *ArtifactUploadInitResponse {
	return &ArtifactUploadInitResponse{
		UploadID: "upload-1",
		MaxBytes: 1024 * 1024,
		Uploads: []ArtifactUpload{
			{
				ServiceName:   "api",
				SourceRef:     "myrepo-api",
				LocalImageRef: "myrepo-api",
				R2Key:         "compose-image-artifacts/proj1/env-1/ws/upload-1/api.tar",
				UploadURL:     uploadURL,
				MaxBytes:      1024 * 1024,
				ArchiveType:   "docker-save",
				MediaType:     "application/vnd.docker.image.rootfs.diff.tar",
			},
			{
				ServiceName:   "worker",
				SourceRef:     "myrepo-worker",
				LocalImageRef: "myrepo-worker",
				R2Key:         "compose-image-artifacts/proj1/env-1/ws/upload-1/worker.tar",
				UploadURL:     uploadURL,
				MaxBytes:      1024 * 1024,
				ArchiveType:   "docker-save",
				MediaType:     "application/vnd.docker.image.rootfs.diff.tar",
			},
		},
	}
}

// sampleArtifact builds a two-service host-built artifact.
func sampleArtifact() *BuildArtifact {
	return &BuildArtifact{
		Reference:   "latest",
		ComposeYAML: []byte("services:\n  api:\n    build: .\n  worker:\n    build: .\n"),
		Services: []BuiltService{
			{ServiceName: "api", LocalRef: "myrepo-api", Digest: "sha256:aaa", MediaType: "application/vnd.oci.image.manifest.v1+json", Size: 100},
			{ServiceName: "worker", LocalRef: "myrepo-worker", Digest: "sha256:bbb", MediaType: "application/vnd.oci.image.manifest.v1+json", Size: 200},
		},
	}
}

func TestPublishHappyPath(t *testing.T) {
	server, uploads := artifactUploadServer(t)
	defer server.Close()
	art := sampleArtifact()
	docker := &fakeDocker{}
	control := &fakeControlPlane{
		initResp: sampleUploadInit(server.URL),
		result:   &ReleaseResult{ReleaseID: "rel1", Version: 1, Status: "created"},
	}

	orch := New(Options{ControlPlane: control, Docker: docker})

	submittedBy := &ReleaseSubmittedBy{TaskID: "task-1", AgentProfileID: "profile-1"}
	res, err := orch.Publish(context.Background(), "proj1", "staging", "env-1", art, submittedBy)
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if res.ReleaseID != "rel1" || res.Status != "created" {
		t.Fatalf("unexpected result: %+v", res)
	}

	if control.initCalls != 1 {
		t.Errorf("init calls = %d, want 1", control.initCalls)
	}
	if control.initProject != "proj1" {
		t.Errorf("init project = %q, want proj1", control.initProject)
	}
	if control.initRequest.Environment != "staging" || control.initRequest.EnvironmentID != "env-1" || control.initRequest.AgentProfileID != "profile-1" {
		t.Errorf("init request = %+v, want staging/env-1/profile-1", control.initRequest)
	}
	if len(docker.saves) != 2 {
		t.Fatalf("save count = %d, want 2", len(docker.saves))
	}
	if len(*uploads) != 2 {
		t.Fatalf("upload count = %d, want 2", len(*uploads))
	}
	if (*uploads)[0] != "archive:myrepo-api" || (*uploads)[1] != "archive:myrepo-worker" {
		t.Fatalf("unexpected uploaded archives: %#v", *uploads)
	}

	// The release submission carries the resolved compose + per-service refs.
	if control.submittedProj != "proj1" {
		t.Errorf("submitted project = %q, want proj1", control.submittedProj)
	}
	sub := control.submitted
	if sub == nil {
		t.Fatal("no release submitted")
	}
	if sub.Reference != "latest" {
		t.Errorf("submitted reference = %q, want latest", sub.Reference)
	}
	if sub.Environment != "staging" || sub.EnvironmentID != "env-1" {
		t.Errorf("submitted environment = %q/%q, want staging/env-1", sub.Environment, sub.EnvironmentID)
	}
	if sub.SubmittedBy != submittedBy {
		t.Errorf("submittedBy not preserved")
	}
	if sub.ComposeYAML != string(art.ComposeYAML) {
		t.Errorf("compose yaml mismatch")
	}
	if len(sub.Services) != 2 {
		t.Fatalf("services = %d, want 2", len(sub.Services))
	}
	api := sub.Services[0]
	if api.ServiceName != "api" || api.ArchiveType != "docker-save" {
		t.Errorf("unexpected api service: %+v", api)
	}
	if api.SourceRef != "myrepo-api" {
		t.Errorf("api sourceRef = %q", api.SourceRef)
	}
	if api.PushedRef != "" {
		t.Errorf("api pushedRef should be empty for R2 path, got %q", api.PushedRef)
	}
	if api.R2Key == "" || api.SizeBytes <= 0 || !strings.HasPrefix(api.ArchiveSHA256, "sha256:") {
		t.Errorf("api artifact descriptor incomplete: %+v", api)
	}
	if control.completed == nil || len(control.completed.Artifacts) != 2 {
		t.Fatalf("expected completed artifacts, got %#v", control.completed)
	}
}

func TestPublishSanitizesServiceNameInTarget(t *testing.T) {
	server, _ := artifactUploadServer(t)
	defer server.Close()
	art := &BuildArtifact{
		Reference: "latest",
		Services: []BuiltService{
			{ServiceName: "API Server", LocalRef: "stack-api", Digest: "sha256:aaa"},
		},
	}
	docker := &fakeDocker{}
	control := &fakeControlPlane{
		initResp: &ArtifactUploadInitResponse{UploadID: "upload-1", MaxBytes: 1024, Uploads: []ArtifactUpload{{
			ServiceName: "API Server", SourceRef: "stack-api", LocalImageRef: "stack-api", R2Key: "key", UploadURL: server.URL, MaxBytes: 1024, ArchiveType: "docker-save", MediaType: "application/vnd.docker.image.rootfs.diff.tar",
		}}},
		result: &ReleaseResult{ReleaseID: "rel1", Version: 1, Status: "created"},
	}

	orch := New(Options{ControlPlane: control, Docker: docker})

	submittedBy := &ReleaseSubmittedBy{TaskID: "task-1", AgentProfileID: "profile-1"}
	if _, err := orch.Publish(context.Background(), "proj1", "staging", "env-1", art, submittedBy); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if len(docker.saves) != 1 {
		t.Fatalf("save count = %d, want 1", len(docker.saves))
	}
	got := docker.saves[0]
	if got[0] != "stack-api" {
		t.Fatalf("source ref = %q", got[0])
	}
	if !strings.HasSuffix(got[1], "api-server.tar") {
		t.Fatalf("archive path = %q", got[1])
	}
	if control.submitted == nil || len(control.submitted.Services) != 1 {
		t.Fatal("expected one submitted service")
	}
	if control.submitted.Services[0].ServiceName != "API Server" {
		t.Fatalf("submitted serviceName = %q, want original compose service name", control.submitted.Services[0].ServiceName)
	}
	if control.submitted.Services[0].RegistryServiceName != "api-server" {
		t.Fatalf("submitted registryServiceName = %q, want api-server", control.submitted.Services[0].RegistryServiceName)
	}
}

func TestPublishNilArtifact(t *testing.T) {
	orch := New(Options{ControlPlane: &fakeControlPlane{}, Docker: &fakeDocker{}})
	if _, err := orch.Publish(context.Background(), "proj1", "staging", "env-1", nil, nil); err == nil {
		t.Fatal("expected error for nil artifact")
	}
}

func TestPublishEmptyProjectID(t *testing.T) {
	orch := New(Options{ControlPlane: &fakeControlPlane{}, Docker: &fakeDocker{}})
	if _, err := orch.Publish(context.Background(), "", "staging", "env-1", sampleArtifact(), nil); err == nil {
		t.Fatal("expected error for empty projectID")
	}
}

func TestPublishArtifactInitFailureStops(t *testing.T) {
	docker := &fakeDocker{}
	control := &fakeControlPlane{initErr: errors.New("rate limited")}

	orch := New(Options{ControlPlane: control, Docker: docker})
	_, err := orch.Publish(context.Background(), "proj1", "staging", "env-1", sampleArtifact(), &ReleaseSubmittedBy{AgentProfileID: "profile-1"})
	if err == nil {
		t.Fatal("expected error")
	}
	if len(docker.saves) != 0 {
		t.Errorf("docker should not be touched after init failure")
	}
}

func TestPublishSaveFailureStops(t *testing.T) {
	server, _ := artifactUploadServer(t)
	defer server.Close()
	docker := &fakeDocker{saveErr: errors.New("save failed")}
	control := &fakeControlPlane{initResp: sampleUploadInit(server.URL), result: &ReleaseResult{}}

	orch := New(Options{ControlPlane: control, Docker: docker})
	_, err := orch.Publish(context.Background(), "proj1", "staging", "env-1", sampleArtifact(), &ReleaseSubmittedBy{AgentProfileID: "profile-1"})
	if err == nil {
		t.Fatal("expected error")
	}
	if control.submitted != nil {
		t.Errorf("release should not be submitted after push failure")
	}
}

func TestPublishRequiresAgentProfileID(t *testing.T) {
	docker := &fakeDocker{}
	control := &fakeControlPlane{}

	orch := New(Options{ControlPlane: control, Docker: docker})
	_, err := orch.Publish(context.Background(), "proj1", "staging", "env-1", sampleArtifact(), nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "agentProfileID") {
		t.Fatalf("error = %q, want agentProfileID context", err)
	}
	if control.initCalls != 0 || len(docker.saves) != 0 {
		t.Fatalf("publish touched external dependencies before profile validation")
	}
}

func TestServiceSlugFallbacks(t *testing.T) {
	cases := []struct {
		svc   BuiltService
		index int
		want  string
	}{
		{BuiltService{ServiceName: "API Server"}, 0, "api-server"},
		{BuiltService{ServiceName: "web_frontend"}, 1, "web-frontend"},
		{BuiltService{}, 2, "service-2"},
		{BuiltService{ServiceName: "!!!"}, 3, "service-3"},
	}
	for _, tc := range cases {
		if got := serviceSlug(tc.svc, tc.index); got != tc.want {
			t.Errorf("serviceSlug(%+v,%d) = %q, want %q", tc.svc, tc.index, got, tc.want)
		}
	}
}

func TestTargetRefDigestReferenceFallsBackToLatest(t *testing.T) {
	creds := &PushCredentials{Registry: "reg", Namespace: "ns"}
	got := targetRef(creds, "api", "sha256:deadbeef")
	want := "reg/ns-api:latest"
	if got != want {
		t.Errorf("targetRef digest ref = %q, want %q", got, want)
	}
}

func TestTargetRefEmptyReferenceFallsBackToLatest(t *testing.T) {
	creds := &PushCredentials{Registry: "reg", Namespace: "ns"}
	got := targetRef(creds, "api", "")
	want := "reg/ns-api:latest"
	if got != want {
		t.Errorf("targetRef empty ref = %q, want %q", got, want)
	}
}

func TestIsDigestReference(t *testing.T) {
	if !IsDigestReference("sha256:abc") {
		t.Error("sha256: prefix should be a digest reference")
	}
	if IsDigestReference("latest") {
		t.Error("latest should not be a digest reference")
	}
}
