package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/workspace/vm-agent/internal/config"
)

func TestProviderLimitCallbackKeepsResetAndRedactsProviderText(t *testing.T) {
	for _, mode := range []string{config.TaskModeTask, config.TaskModeConversation} {
		t.Run(mode, func(t *testing.T) {
			reset := time.Now().Add(time.Hour).Unix()
			var request acpsdk.RequestError
			wire := map[string]interface{}{"code": -32603, "message": "Internal error", "data": map[string]interface{}{"codexErrorInfo": "usageLimitExceeded", "resetsAt": reset, "message": "You've hit your usage limit sk-secret-canary"}}
			encoded, _ := json.Marshal(wire)
			if err := json.Unmarshal(encoded, &request); err != nil {
				t.Fatal(err)
			}
			body := runTaskCompletionCallback(t, mode, "error", &request)
			if body["errorMessage"] != "provider_limit_reached" || body["providerLimitResetsAt"] != float64(reset*1000) {
				t.Fatalf("callback=%v", body)
			}
			if body["toStatus"] != "failed" {
				t.Fatal("additive request protocol changed")
			}
			encoded, _ = json.Marshal(body)
			if strings.Contains(string(encoded), "sk-secret-canary") {
				t.Fatal("provider text leaked")
			}
		})
	}
}
