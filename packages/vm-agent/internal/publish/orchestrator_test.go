package publish

import (
	"context"
	"errors"
	"testing"

	"github.com/workspace/vm-agent/internal/oci"
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

func sampleCaptured() *oci.CapturedPublish {
	return &oci.CapturedPublish{
		Repository:       "sam/test-one",
		Reference:        "latest",
		ProjectDigest:    "sha256:proj",
		ImageIndexDigest: "sha256:index",
		ComposeYAML:      []byte("services:\n  api:\n    build: .\n"),
		ImageDigestsYAML: []byte("services:\n  api:\n    image: x@sha256:aaa\n"),
		Services: []oci.ServiceImage{
			{Digest: "sha256:aaa", MediaType: oci.MediaTypeImageManifest, Size: 100, ServiceName: "api"},
			{Digest: "sha256:bbb", MediaType: oci.MediaTypeImageManifest, Size: 200, ServiceName: "worker"},
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
	cp := sampleCaptured()
	docker := &fakeDocker{pushDigests: map[string]string{
		"registry.cloudflare.com/acct123/sam-proj1-api:latest":    "sha256:aaa",
		"registry.cloudflare.com/acct123/sam-proj1-worker:latest": "sha256:bbb",
	}}
	control := &fakeControlPlane{
		creds:  creds,
		result: &ReleaseResult{ReleaseID: "rel1", Version: 1, Status: "created"},
	}

	orch := New(Options{
		ControlPlane: control,
		Docker:       docker,
		PublishHost:  "sam-registry.local:5050",
	})

	res, err := orch.Publish(context.Background(), "proj1", cp)
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

	// Both built images were re-tagged from the host-daemon source ref into the
	// project namespace, then pushed.
	wantTags := map[string]string{
		"sam-registry.local:5050/sam/test-one@sha256:aaa": "registry.cloudflare.com/acct123/sam-proj1-api:latest",
		"sam-registry.local:5050/sam/test-one@sha256:bbb": "registry.cloudflare.com/acct123/sam-proj1-worker:latest",
	}
	if len(docker.tags) != 2 {
		t.Fatalf("tag count = %d, want 2", len(docker.tags))
	}
	for _, pair := range docker.tags {
		if want := wantTags[pair[0]]; want != pair[1] {
			t.Errorf("tag %s -> %s, want -> %s", pair[0], pair[1], want)
		}
	}

	// The release submission carries the captured topology and per-service refs.
	if control.submittedProj != "proj1" {
		t.Errorf("submitted project = %q, want proj1", control.submittedProj)
	}
	sub := control.submitted
	if sub == nil {
		t.Fatal("no release submitted")
	}
	if sub.ProjectDigest != "sha256:proj" || sub.ImageIndexDigest != "sha256:index" {
		t.Errorf("unexpected digests: %+v", sub)
	}
	if string(sub.ComposeYAML) != string(cp.ComposeYAML) {
		t.Errorf("compose yaml mismatch")
	}
	if len(sub.Services) != 2 {
		t.Fatalf("services = %d, want 2", len(sub.Services))
	}
	api := sub.Services[0]
	if api.ServiceName != "api" || api.Digest != "sha256:aaa" {
		t.Errorf("unexpected api service: %+v", api)
	}
	if api.PushedRef != "registry.cloudflare.com/acct123/sam-proj1-api@sha256:aaa" {
		t.Errorf("api pushedRef = %q", api.PushedRef)
	}
}

func TestPublishUsesServiceRepositoryWhenPresent(t *testing.T) {
	creds := &PushCredentials{
		Registry:  "registry.cloudflare.com",
		Username:  "v1",
		Password:  "secret",
		Namespace: "acct123/sam-proj1",
	}
	cp := sampleCaptured()
	cp.Services = []oci.ServiceImage{
		{
			Repository:  "sam/test-one/api",
			Digest:      "sha256:aaa",
			MediaType:   oci.MediaTypeImageManifest,
			Size:        100,
			ServiceName: "api",
		},
	}
	docker := &fakeDocker{pushDigests: map[string]string{
		"registry.cloudflare.com/acct123/sam-proj1-api:latest": "sha256:aaa",
	}}
	control := &fakeControlPlane{
		creds:  creds,
		result: &ReleaseResult{ReleaseID: "rel1", Version: 1, Status: "created"},
	}

	orch := New(Options{
		ControlPlane: control,
		Docker:       docker,
		PublishHost:  "sam-registry.local:5050",
	})

	if _, err := orch.Publish(context.Background(), "proj1", cp); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if len(docker.tags) != 1 {
		t.Fatalf("tag count = %d, want 1", len(docker.tags))
	}
	got := docker.tags[0]
	if got[0] != "sam-registry.local:5050/sam/test-one/api@sha256:aaa" {
		t.Fatalf("source ref = %q", got[0])
	}
	if got[1] != "registry.cloudflare.com/acct123/sam-proj1-api:latest" {
		t.Fatalf("target ref = %q", got[1])
	}
}

func TestPublishMintFailureStops(t *testing.T) {
	docker := &fakeDocker{pushDigests: map[string]string{}}
	control := &fakeControlPlane{mintErr: errors.New("rate limited")}

	orch := New(Options{ControlPlane: control, Docker: docker})
	_, err := orch.Publish(context.Background(), "proj1", sampleCaptured())
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

	orch := New(Options{ControlPlane: control, Docker: docker, PublishHost: "h"})
	_, err := orch.Publish(context.Background(), "proj1", sampleCaptured())
	if err == nil {
		t.Fatal("expected error")
	}
	if control.submitted != nil {
		t.Errorf("release should not be submitted after push failure")
	}
}

func TestServiceSlugFallbacks(t *testing.T) {
	cases := []struct {
		svc   oci.ServiceImage
		index int
		want  string
	}{
		{oci.ServiceImage{ServiceName: "API Server"}, 0, "api-server"},
		{oci.ServiceImage{RefName: "ghcr.io/x/web:v1"}, 1, "ghcr-io-x-web-v1"},
		{oci.ServiceImage{}, 2, "service-2"},
		{oci.ServiceImage{ServiceName: "!!!"}, 3, "service-3"},
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
