package publish

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPControlPlaneMintPushCredentialsSendsPolicyContext(t *testing.T) {
	var gotPath string
	var gotAuth string
	var gotContentType string
	var gotBody PushCredentialsRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"registry": "registry.cloudflare.com",
			"username": "u",
			"password": "p",
			"namespace": "acct/sam-proj1",
			"expiresAt": "2026-06-21T00:00:00Z"
		}`))
	}))
	defer srv.Close()

	cp := NewHTTPControlPlane(HTTPControlPlaneOptions{
		BaseURL: srv.URL,
		Token:   "callback-token",
		Client:  srv.Client(),
	})

	creds, err := cp.MintPushCredentials(context.Background(), "proj1", PushCredentialsRequest{
		Environment:    "staging",
		AgentProfileID: "profile-1",
	})
	if err != nil {
		t.Fatalf("MintPushCredentials: %v", err)
	}

	if gotPath != "/api/projects/proj1/registry-push-credentials" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer callback-token" {
		t.Fatalf("authorization header = %q", gotAuth)
	}
	if gotContentType != "application/json" {
		t.Fatalf("content-type = %q", gotContentType)
	}
	if gotBody.Environment != "staging" || gotBody.AgentProfileID != "profile-1" {
		t.Fatalf("body = %+v, want staging/profile-1", gotBody)
	}
	if creds.Registry != "registry.cloudflare.com" || creds.Namespace != "acct/sam-proj1" {
		t.Fatalf("credentials = %+v", creds)
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
