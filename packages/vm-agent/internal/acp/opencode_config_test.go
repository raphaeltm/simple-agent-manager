package acp

import (
	"encoding/json"
	"testing"
)

func TestBuildOpenCodeConfig_PlatformProxy(t *testing.T) {
	cred := &agentCredential{
		credential:     "proxy",
		credentialKind: "api-key",
		inferenceConfig: &inferenceConfig{
			Provider:     "openai-compatible",
			BaseURL:      "https://api.example.com/ai/v1",
			Model:        "@cf/qwen/qwen3-30b-a3b-fp8",
			ApiKeySource: "callback-token",
		},
	}
	settings := &agentSettingsPayload{Model: ""}
	callbackToken := "cb-token-123"

	result := buildOpenCodeConfig(cred, settings, callbackToken)

	// Marshal and re-parse to verify structure
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}

	// Verify model uses sam-ai/ prefix
	model, ok := parsed["model"].(string)
	if !ok || model != "sam-ai/@cf/qwen/qwen3-30b-a3b-fp8" {
		t.Errorf("expected model 'sam-ai/@cf/qwen/qwen3-30b-a3b-fp8', got %q", model)
	}

	// Verify provider structure
	providers, ok := parsed["provider"].(map[string]interface{})
	if !ok {
		t.Fatal("expected 'provider' to be an object")
	}
	samAI, ok := providers["sam-ai"].(map[string]interface{})
	if !ok {
		t.Fatal("expected 'sam-ai' provider entry")
	}

	if npm, _ := samAI["npm"].(string); npm != "@ai-sdk/openai-compatible" {
		t.Errorf("expected npm '@ai-sdk/openai-compatible', got %q", npm)
	}

	options, ok := samAI["options"].(map[string]interface{})
	if !ok {
		t.Fatal("expected 'options' in sam-ai provider")
	}

	if baseURL, _ := options["baseURL"].(string); baseURL != "https://api.example.com/ai/v1" {
		t.Errorf("expected baseURL 'https://api.example.com/ai/v1', got %q", baseURL)
	}

	// Key check: callback token should be used as apiKey
	if apiKey, _ := options["apiKey"].(string); apiKey != "cb-token-123" {
		t.Errorf("expected apiKey to be callback token 'cb-token-123', got %q", apiKey)
	}
}

func TestBuildOpenCodeConfig_PlatformProxy_UserModelOverride(t *testing.T) {
	cred := &agentCredential{
		credential:     "proxy",
		credentialKind: "api-key",
		inferenceConfig: &inferenceConfig{
			Provider:     "openai-compatible",
			BaseURL:      "https://api.example.com/ai/v1",
			Model:        "@cf/qwen/qwen3-30b-a3b-fp8",
			ApiKeySource: "callback-token",
		},
	}
	settings := &agentSettingsPayload{Model: "custom-model-override"}
	callbackToken := "cb-token-456"

	result := buildOpenCodeConfig(cred, settings, callbackToken)

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}

	// User model override should take precedence
	model, _ := parsed["model"].(string)
	if model != "sam-ai/custom-model-override" {
		t.Errorf("expected model 'sam-ai/custom-model-override', got %q", model)
	}
}

func TestBuildOpenCodeConfig_LegacyScaleway(t *testing.T) {
	cred := &agentCredential{
		credential:      "scw-secret-key",
		credentialKind:  "api-key",
		inferenceConfig: nil, // No inference config = legacy path
	}
	settings := &agentSettingsPayload{Model: ""}
	callbackToken := "cb-token-unused"

	result := buildOpenCodeConfig(cred, settings, callbackToken)

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}

	// Should use scaleway defaults
	model, _ := parsed["model"].(string)
	if model != "scaleway/qwen3-coder-30b-a3b-instruct" {
		t.Errorf("expected model 'scaleway/qwen3-coder-30b-a3b-instruct', got %q", model)
	}

	providers, ok := parsed["provider"].(map[string]interface{})
	if !ok {
		t.Fatal("expected 'provider' to be an object")
	}
	scaleway, ok := providers["scaleway"].(map[string]interface{})
	if !ok {
		t.Fatal("expected 'scaleway' provider entry")
	}

	options, ok := scaleway["options"].(map[string]interface{})
	if !ok {
		t.Fatal("expected 'options' in scaleway provider")
	}

	if baseURL, _ := options["baseURL"].(string); baseURL != "https://api.scaleway.ai/v1" {
		t.Errorf("expected Scaleway baseURL, got %q", baseURL)
	}
	if apiKey, _ := options["apiKey"].(string); apiKey != "{env:SCW_SECRET_KEY}" {
		t.Errorf("expected env reference for apiKey, got %q", apiKey)
	}
}

func TestBuildOpenCodeConfig_LegacyScaleway_UserModelOverride(t *testing.T) {
	cred := &agentCredential{
		credential:      "scw-secret-key",
		credentialKind:  "api-key",
		inferenceConfig: nil,
	}
	settings := &agentSettingsPayload{Model: "my-custom/model"}
	callbackToken := "unused"

	result := buildOpenCodeConfig(cred, settings, callbackToken)

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}

	model, _ := parsed["model"].(string)
	if model != "my-custom/model" {
		t.Errorf("expected model 'my-custom/model', got %q", model)
	}
}

func TestBuildOpenCodeConfig_NilSettings(t *testing.T) {
	// Platform proxy with nil settings — should use default model
	cred := &agentCredential{
		credential:     "proxy",
		credentialKind: "api-key",
		inferenceConfig: &inferenceConfig{
			Provider:     "openai-compatible",
			BaseURL:      "https://api.example.com/ai/v1",
			Model:        "@cf/qwen/qwen3-30b-a3b-fp8",
			ApiKeySource: "callback-token",
		},
	}

	result := buildOpenCodeConfig(cred, nil, "cb-token")

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}

	model, _ := parsed["model"].(string)
	if model != "sam-ai/@cf/qwen/qwen3-30b-a3b-fp8" {
		t.Errorf("expected default model with sam-ai/ prefix, got %q", model)
	}
}

func TestBuildOpenCodeConfig_NilSettings_Legacy(t *testing.T) {
	// Legacy Scaleway with nil settings — should use Scaleway defaults
	cred := &agentCredential{
		credential:      "scw-key",
		credentialKind:  "api-key",
		inferenceConfig: nil,
	}

	result := buildOpenCodeConfig(cred, nil, "unused")

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}

	model, _ := parsed["model"].(string)
	if model != "scaleway/qwen3-coder-30b-a3b-instruct" {
		t.Errorf("expected Scaleway default model, got %q", model)
	}
}
