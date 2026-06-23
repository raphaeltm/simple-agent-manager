package publish

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPControlPlaneInitArtifactUploadsSendsScopedRequest(t *testing.T) {
	var gotPath string
	var gotAuth string
	var gotContentType string
	var gotBody ArtifactUploadRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"uploadId": "upload-1",
			"maxBytes": 1024,
			"uploads": [{
				"serviceName": "web",
				"sourceRef": "workspace-web",
				"localImageRef": "workspace-web",
				"r2Key": "compose-image-artifacts/proj1/env-1/ws/upload-1/web.tar",
				"uploadUrl": "https://r2.example/upload",
				"maxBytes": 1024,
				"archiveType": "docker-save",
				"mediaType": "application/vnd.docker.image.rootfs.diff.tar"
			}]
		}`))
	}))
	defer srv.Close()

	cp := NewHTTPControlPlane(HTTPControlPlaneOptions{
		BaseURL: srv.URL,
		Token:   "callback-token",
		Client:  srv.Client(),
	})

	result, err := cp.InitArtifactUploads(context.Background(), "proj1", ArtifactUploadRequest{
		Environment:    "staging",
		EnvironmentID:  "env-1",
		AgentProfileID: "profile-1",
		Services:       []ArtifactServiceInput{{ServiceName: "web", SourceRef: "workspace-web"}},
	})
	if err != nil {
		t.Fatalf("InitArtifactUploads: %v", err)
	}

	if gotPath != "/api/projects/proj1/compose-image-artifacts/init" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer callback-token" {
		t.Fatalf("authorization header = %q", gotAuth)
	}
	if gotContentType != "application/json" {
		t.Fatalf("content-type = %q", gotContentType)
	}
	if gotBody.Environment != "staging" || gotBody.EnvironmentID != "env-1" || gotBody.AgentProfileID != "profile-1" {
		t.Fatalf("body = %+v, want staging/env-1/profile-1", gotBody)
	}
	if len(gotBody.Services) != 1 || gotBody.Services[0].SourceRef != "workspace-web" {
		t.Fatalf("body services = %+v", gotBody.Services)
	}
	if result.UploadID != "upload-1" || len(result.Uploads) != 1 || result.Uploads[0].R2Key == "" {
		t.Fatalf("result = %+v", result)
	}
}

func TestHTTPControlPlaneCompleteArtifactUploadsSendsDescriptors(t *testing.T) {
	var gotPath string
	var gotBody ArtifactCompleteRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	cp := NewHTTPControlPlane(HTTPControlPlaneOptions{
		BaseURL: srv.URL,
		Token:   "callback-token",
		Client:  srv.Client(),
	})

	err := cp.CompleteArtifactUploads(context.Background(), "proj1", ArtifactCompleteRequest{
		Environment:    "staging",
		EnvironmentID:  "env-1",
		AgentProfileID: "profile-1",
		Artifacts: []ServiceRelease{{
			ServiceName:   "web",
			SourceRef:     "workspace-web",
			R2Key:         "compose-image-artifacts/proj1/env-1/ws/upload-1/web.tar",
			SizeBytes:     12,
			ArchiveSHA256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			ArchiveType:   "docker-save",
			MediaType:     "application/vnd.docker.image.rootfs.diff.tar",
		}},
	})
	if err != nil {
		t.Fatalf("CompleteArtifactUploads: %v", err)
	}
	if gotPath != "/api/projects/proj1/compose-image-artifacts/complete" {
		t.Fatalf("path = %q", gotPath)
	}
	if len(gotBody.Artifacts) != 1 || gotBody.Artifacts[0].ServiceName != "web" {
		t.Fatalf("body = %+v", gotBody)
	}
}

func TestHTTPControlPlaneSubmitReleaseSendsReleasePayload(t *testing.T) {
	var gotPath string
	var gotAuth string
	var gotBody ReleaseSubmission

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"releaseId":"rel1","version":3,"status":"created"}`))
	}))
	defer srv.Close()

	cp := NewHTTPControlPlane(HTTPControlPlaneOptions{
		BaseURL: srv.URL,
		Token:   "callback-token",
		Client:  srv.Client(),
	})

	result, err := cp.SubmitRelease(context.Background(), "proj1", &ReleaseSubmission{
		Environment:   "staging",
		EnvironmentID: "env-1",
		Reference:     "latest",
		ComposeYAML:   "services: {}",
		SubmittedBy:   &ReleaseSubmittedBy{TaskID: "task-1", AgentProfileID: "profile-1"},
	})
	if err != nil {
		t.Fatalf("SubmitRelease: %v", err)
	}

	if gotPath != "/api/projects/proj1/compose-publish-release" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer callback-token" {
		t.Fatalf("authorization header = %q", gotAuth)
	}
	if gotBody.Environment != "staging" || gotBody.EnvironmentID != "env-1" {
		t.Fatalf("body environment = %q/%q", gotBody.Environment, gotBody.EnvironmentID)
	}
	if gotBody.SubmittedBy == nil || gotBody.SubmittedBy.AgentProfileID != "profile-1" {
		t.Fatalf("body submittedBy = %+v", gotBody.SubmittedBy)
	}
	if result.ReleaseID != "rel1" || result.Version != 3 || result.Status != "created" {
		t.Fatalf("result = %+v", result)
	}
}
