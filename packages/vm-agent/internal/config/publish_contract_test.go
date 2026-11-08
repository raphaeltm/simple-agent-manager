package config

import (
	"os"
	"strconv"
	"testing"
	"time"
)

// The combined Worker/Go contract test supplies defaults resolved through the
// real API registry. Load resolves the VM side without a timeout override.
func TestPublishDeadlineDefaultContract(t *testing.T) {
	deadlineRaw := os.Getenv("SAM_TEST_API_PUBLISH_DEADLINE_MS")
	if deadlineRaw == "" {
		t.Skip("run through the API default contract in the combined Go/Worker job")
	}
	deadline, err := strconv.ParseInt(deadlineRaw, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	margin, err := strconv.ParseInt(os.Getenv("SAM_TEST_API_PUBLISH_MARGIN_MS"), 10, 64)
	if err != nil || margin <= 0 {
		t.Fatal("positive API admission/callback margin required")
	}
	t.Setenv("DEPLOY_BUILD_PUBLISH_TIMEOUT", "")
	t.Setenv("DEPLOY_PUBLISH_HEARTBEAT_INTERVAL", "")
	t.Setenv("HTTP_CALLBACK_TIMEOUT", "")
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("NODE_ID", "node-contract")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if time.Duration(deadline)*time.Millisecond <= cfg.DeployBuildPublishTimeout+time.Duration(margin)*time.Millisecond {
		t.Fatalf("API deadline %dms must exceed resolved VM timeout %v plus %dms admission/callback margin", deadline, cfg.DeployBuildPublishTimeout, margin)
	}
	stall, err := strconv.ParseInt(os.Getenv("SAM_TEST_API_PUBLISH_STALL_MS"), 10, 64)
	if err != nil || time.Duration(stall)*time.Millisecond <= cfg.DeployPublishHeartbeatInterval+cfg.HTTPCallbackTimeout {
		t.Fatalf("API stall %dms must exceed resolved heartbeat interval %v plus callback timeout %v", stall, cfg.DeployPublishHeartbeatInterval, cfg.HTTPCallbackTimeout)
	}
}

func TestPublishHeartbeatConfiguration(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("NODE_ID", "node-contract")
	t.Setenv("DEPLOY_PUBLISH_HEARTBEAT_INTERVAL", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DeployPublishHeartbeatInterval != DefaultDeployPublishHeartbeatInterval {
		t.Fatalf("default heartbeat interval = %v", cfg.DeployPublishHeartbeatInterval)
	}
	t.Setenv("DEPLOY_PUBLISH_HEARTBEAT_INTERVAL", "2s")
	cfg, err = Load()
	if err != nil || cfg.DeployPublishHeartbeatInterval != 2*time.Second {
		t.Fatalf("configured heartbeat interval = %v, err = %v", cfg.DeployPublishHeartbeatInterval, err)
	}
}
