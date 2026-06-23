package deploy

import "testing"

func TestServiceHealthy(t *testing.T) {
	cases := []struct {
		name string
		svc  ServiceState
		want bool
	}{
		{"running no healthcheck", ServiceState{Status: "running", Health: ""}, true},
		{"running healthy", ServiceState{Status: "running", Health: "healthy"}, true},
		{"running none", ServiceState{Status: "running", Health: "none"}, true},
		{"running unhealthy", ServiceState{Status: "running", Health: "unhealthy"}, false},
		{"running starting", ServiceState{Status: "running", Health: "starting"}, false},
		{"exited healthy", ServiceState{Status: "exited", Health: "healthy"}, false},
		{"restarting", ServiceState{Status: "restarting", Health: ""}, false},
	}
	for _, tc := range cases {
		if got := serviceHealthy(tc.svc); got != tc.want {
			t.Fatalf("%s: serviceHealthy=%v want %v", tc.name, got, tc.want)
		}
	}
}

func TestRoutedServicesHealthy_AllRequiredHealthy(t *testing.T) {
	required := map[string]bool{"web": true, "api": true}
	services := []ServiceState{
		{Service: "web", Status: "running", Health: "healthy"},
		{Service: "api", Status: "running", Health: "none"},
		{Service: "db", Status: "running", Health: "unhealthy"}, // not required, ignored
	}
	if !routedServicesHealthy(services, required) {
		t.Fatalf("expected all required services healthy")
	}
}

func TestRoutedServicesHealthy_OneRequiredUnhealthy(t *testing.T) {
	required := map[string]bool{"web": true, "api": true}
	services := []ServiceState{
		{Service: "web", Status: "running", Health: "healthy"},
		{Service: "api", Status: "running", Health: "starting"}, // not yet healthy
	}
	if routedServicesHealthy(services, required) {
		t.Fatalf("expected false while a required service is still starting")
	}
}

func TestRoutedServicesHealthy_MissingRequiredService(t *testing.T) {
	required := map[string]bool{"web": true, "api": true}
	services := []ServiceState{
		{Service: "web", Status: "running", Health: "healthy"},
		// api container not present at all
	}
	if routedServicesHealthy(services, required) {
		t.Fatalf("expected false when a required service has no container")
	}
}

func TestRoutedServicesHealthy_NoRequiredServices(t *testing.T) {
	// With no routed services, health gating is a no-op (vacuously true).
	if !routedServicesHealthy(nil, map[string]bool{}) {
		t.Fatalf("expected true when no services are required")
	}
}
