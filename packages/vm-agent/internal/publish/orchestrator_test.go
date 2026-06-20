package publish

import (
	"context"
	"errors"
	"testing"
)

// fakeControlPlane records mint/submit calls and returns canned responses.
type fakeControlPlane struct {
	creds         *PushCredentials
	mintErr       error
	mintCalls     int
	submitErr     error
	submitted     *ReleaseSubmission
	submittedProj string
	result        *ReleaseResult
}

func (f *fakeControlPlane) MintPushCredentials(_ context.Context, _ string) (*PushCredentials, error) {
	f.mintCalls++
	if f.mintErr != nil {
		return nil, f.mintErr
	}
	return f.creds, nil
}

func (f *fakeControlPlane) SubmitRelease(_ context.Context, projectID string, req *ReleaseSubmission) (*ReleaseResult, error) {
	if f.submitErr != nil {
		return nil, f.submitErr
	}
	f.submittedProj = projectID
	f.submitted = req
	return f.result, nil
}

// fakeDocker records login/tag/push calls and maps push targets to digests.
type fakeDocker struct {
	loginCalls  int
	tags        [][2]string // [source, target]
	pushed      []string
	pushDigests map[string]string
	loginErr    error
	tagErr      error
	pushErr     error
}

func (d *fakeDocker) Login(_ context.Context, _, _, _ string) error {
	d.loginCalls++
	return d.loginErr
}

func (d *fakeDocker) Tag(_ context.Context, source, target string) error {
	if d.tagErr != nil {
		return d.tagErr
	}
	d.tags = append(d.tags, [2]string{source, target})
	return nil
}

func (d *fakeDocker) Push(_ context.Context, ref string) (string, error) {
	if d.pushErr != nil {
		return "", d.pushErr
	}
	d.pushed = append(d.pushed, ref)
	return d.pushDigests[ref], nil
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
	creds := &PushCredentials{
		Registry:  "registry.cloudflare.com",
		Username:  "v1",
		Password:  "secret",
		Namespace: "acct123/sam-proj1",
		ExpiresAt: "2026-06-19T00:00:00Z",
	}
	art := sampleArtifact()
	docker := &fakeDocker{pushDigests: map[string]string{
		"registry.cloudflare.com/acct123/sam-proj1-api:latest":    "sha256:aaa",
		"registry.cloudflare.com/acct123/sam-proj1-worker:latest": "sha256:bbb",
	}}
	control := &fakeControlPlane{
		creds:  creds,
		result: &ReleaseResult{ReleaseID: "rel1", Version: 1, Status: "created"},
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

	if control.mintCalls != 1 {
		t.Errorf("mint calls = %d, want 1", control.mintCalls)
	}
	if docker.loginCalls != 1 {
		t.Errorf("login calls = %d, want 1", docker.loginCalls)
	}

	// Both built images were re-tagged from their host-daemon LocalRef into the
	// project namespace, then pushed.
	wantTags := map[string]string{
		"myrepo-api":    "registry.cloudflare.com/acct123/sam-proj1-api:latest",
		"myrepo-worker": "registry.cloudflare.com/acct123/sam-proj1-worker:latest",
	}
	if len(docker.tags) != 2 {
		t.Fatalf("tag count = %d, want 2", len(docker.tags))
	}
	for _, pair := range docker.tags {
		if want := wantTags[pair[0]]; want != pair[1] {
			t.Errorf("tag %s -> %s, want -> %s", pair[0], pair[1], want)
		}
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
	if api.ServiceName != "api" || api.Digest != "sha256:aaa" {
		t.Errorf("unexpected api service: %+v", api)
	}
	if api.SourceRef != "myrepo-api" {
		t.Errorf("api sourceRef = %q", api.SourceRef)
	}
	if api.PushedRef != "registry.cloudflare.com/acct123/sam-proj1-api@sha256:aaa" {
		t.Errorf("api pushedRef = %q", api.PushedRef)
	}
}

func TestPublishSanitizesServiceNameInTarget(t *testing.T) {
	creds := &PushCredentials{
		Registry:  "registry.cloudflare.com",
		Username:  "v1",
		Password:  "secret",
		Namespace: "acct123/sam-proj1",
	}
	art := &BuildArtifact{
		Reference: "latest",
		Services: []BuiltService{
			{ServiceName: "API Server", LocalRef: "stack-api", Digest: "sha256:aaa"},
		},
	}
	docker := &fakeDocker{pushDigests: map[string]string{
		"registry.cloudflare.com/acct123/sam-proj1-api-server:latest": "sha256:aaa",
	}}
	control := &fakeControlPlane{
		creds:  creds,
		result: &ReleaseResult{ReleaseID: "rel1", Version: 1, Status: "created"},
	}

	orch := New(Options{ControlPlane: control, Docker: docker})

	if _, err := orch.Publish(context.Background(), "proj1", "staging", "env-1", art, nil); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if len(docker.tags) != 1 {
		t.Fatalf("tag count = %d, want 1", len(docker.tags))
	}
	got := docker.tags[0]
	if got[0] != "stack-api" {
		t.Fatalf("source ref = %q", got[0])
	}
	if got[1] != "registry.cloudflare.com/acct123/sam-proj1-api-server:latest" {
		t.Fatalf("target ref = %q", got[1])
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

func TestPublishMintFailureStops(t *testing.T) {
	docker := &fakeDocker{pushDigests: map[string]string{}}
	control := &fakeControlPlane{mintErr: errors.New("rate limited")}

	orch := New(Options{ControlPlane: control, Docker: docker})
	_, err := orch.Publish(context.Background(), "proj1", "staging", "env-1", sampleArtifact(), nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if docker.loginCalls != 0 || len(docker.pushed) != 0 {
		t.Errorf("docker should not be touched after mint failure")
	}
}

func TestPublishPushFailureStops(t *testing.T) {
	creds := &PushCredentials{Registry: "r", Namespace: "n", Username: "u", Password: "p"}
	docker := &fakeDocker{pushDigests: map[string]string{}, pushErr: errors.New("push denied")}
	control := &fakeControlPlane{creds: creds, result: &ReleaseResult{}}

	orch := New(Options{ControlPlane: control, Docker: docker})
	_, err := orch.Publish(context.Background(), "proj1", "staging", "env-1", sampleArtifact(), nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if control.submitted != nil {
		t.Errorf("release should not be submitted after push failure")
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
