package config

import (
	"strings"
	"testing"
)

func TestLoadDeployAppIngress(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "test-workspace")
	cases := []struct {
		name, role, ingress, port string
		wantPort                  int
		wantError                 string
	}{
		{name: "hosted deployment node: public ingress", role: RoleDeployment, wantPort: 0},
		{name: "box deployment node: tunnel ingress, default port", role: RoleDeployment, ingress: "tunnel", wantPort: DefaultDeployAppIngressPort},
		{name: "explicit port", role: RoleDeployment, ingress: "tunnel", port: "9001", wantPort: 9001},
		// A workspace node never serves app ingress, whatever the environment says.
		{name: "workspace node ignores it", role: "workspace", ingress: "tunnel", wantPort: 0},
		// A typo must not silently fall back to public automatic HTTPS.
		{name: "unknown mode fails closed", role: RoleDeployment, ingress: "tunel", wantError: "DEPLOY_APP_INGRESS"},
		{name: "bad port fails closed", role: RoleDeployment, ingress: "tunnel", port: "70000", wantError: "DEPLOY_APP_INGRESS_PORT"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("NODE_ROLE", tc.role)
			t.Setenv("DEPLOY_APP_INGRESS", tc.ingress)
			t.Setenv("DEPLOY_APP_INGRESS_PORT", tc.port)
			cfg, err := Load()
			if tc.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantError) {
					t.Fatalf("Load() error=%v, want %s", err, tc.wantError)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load(): %v", err)
			}
			if got := cfg.AppIngressLoopbackPort(); got != tc.wantPort {
				t.Fatalf("AppIngressLoopbackPort() = %d, want %d", got, tc.wantPort)
			}
		})
	}
}
