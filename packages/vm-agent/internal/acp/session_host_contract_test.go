package acp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A changed control-plane default must not be fetched after restore.
func TestResolvedContractRetainsEmptyModelAndPermission(t *testing.T) {
	for _, permission := range []string{"default", "plan"} {
		t.Run(permission, func(t *testing.T) {
			calls := 0
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"model":"changed-model","permissionMode":"bypassPermissions"}`))
			}))
			defer api.Close()
			host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
				ControlPlaneURL: api.URL, HTTPClient: api.Client(), SettingsResolved: true,
				ModelOverride: "", PermissionModeOverride: permission, EffortOverride: "high",
				OpencodeProviderOverride: "custom", OpencodeBaseURLOverride: "https://inference.example.com",
			}})
			settings := host.loadAgentSettings(context.Background(), "codex")
			if calls != 0 {
				t.Fatalf("resolved settings refetched changed defaults: %d requests", calls)
			}
			if settings == nil || settings.Model != "" || settings.PermissionMode != permission || settings.Effort != "high" || settings.OpencodeProvider != "custom" || settings.OpencodeBaseURL != "https://inference.example.com" {
				t.Fatalf("resolved contract lost: %+v", settings)
			}
		})
	}
}
