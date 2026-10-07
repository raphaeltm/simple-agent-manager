package acp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

type sdkURLFixtureAgent struct {
	acpsdk.Agent
	conn     *acpsdk.AgentSideConnection
	observed chan acpsdk.UnstableCreateElicitationResponse
}

func (a *sdkURLFixtureAgent) Prompt(ctx context.Context, _ acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	response, err := a.conn.UnstableCreateElicitation(ctx, fixtureURLRequest("https://auth.example.com/approve"))
	if err != nil {
		return acpsdk.PromptResponse{}, err
	}
	a.observed <- response
	if err := a.conn.UnstableCompleteElicitation(ctx, acpsdk.UnstableCompleteElicitationNotification{ElicitationId: "remote-service-1"}); err != nil {
		return acpsdk.PromptResponse{}, err
	}
	return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
}

func testURLConfig() AcpInteractionRuntimeConfig {
	config := testInteractionConfig()
	config.URLsEnabled = true
	config.URLDeadlineMs = 2_000
	config.URLMaxChars = 8192
	config.URLElicitationIDMaxChars = 256
	config.URLRedirectDepth = 2
	return config
}

func fixtureURLRequest(raw string) acpsdk.UnstableCreateElicitationRequest {
	request := acpsdk.NewUnstableCreateElicitationRequestUrl("remote-service-1", raw)
	request.Url.Message = "Approve remote service"
	return request
}

func TestURLEligibilityRejectsLocalCallbacksAndUnsafeNavigation(t *testing.T) {
	for _, raw := range []string{
		"http://auth.example.com/connect", "https://localhost/connect", "https://127.0.0.1/connect",
		"https://[::1]/connect", "https://user:password@auth.example.com/connect",
		"https://auth.example.com:8443/connect", "https://xn--e1afmkfd.example/connect",
		"https://auth.example.com/connect?redirect_uri=http%3A%2F%2F127.0.0.1%3A7777%2Fcallback",
		"https://auth.example.com/connect?callback=https%3A%2F%2Flocalhost%2Fdone",
		"https://auth.example.com/connect?redirect_uri=https%3A%2F%2Fuser%3Apass%40done.example.com%2Fcb",
		"https://auth.example.com/connect?next=https%3A%2F%2Fdone.example.com%2F%3Fnext%3Dhttp%253A%252F%252Flocalhost",
		"https://auth.example.com/connect?redirect_uri=%ZZ",
	} {
		if eligibleAcpURL(raw, testURLConfig().URLMaxChars, testURLConfig().URLRedirectDepth) {
			t.Fatalf("unsafe URL accepted: %s", raw)
		}
	}
	if !eligibleAcpURL("https://auth.example.com/connect?state=secret-canary",
		testURLConfig().URLMaxChars, testURLConfig().URLRedirectDepth) {
		t.Fatal("remote HTTPS flow rejected")
	}
}

func TestURLEligibilitySharedCorpus(t *testing.T) {
	data, err := os.ReadFile("../../../shared/tests/fixtures/acp-url-eligibility.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		URL      string `json:"url"`
		Eligible bool   `json:"eligible"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	config := testURLConfig()
	for _, testCase := range cases {
		if got := eligibleAcpURL(testCase.URL, config.URLMaxChars, config.URLRedirectDepth); got != testCase.Eligible {
			t.Errorf("eligibility %q = %t, want %t", testCase.URL, got, testCase.Eligible)
		}
	}
}

func TestURLEligibilityConfiguredBounds(t *testing.T) {
	if eligibleAcpURL("https://auth.example.com/approve", 12, 2) {
		t.Fatal("URL exceeded configured length")
	}
	if eligibleAcpURL("https://auth.example.com/?next=https%3A%2F%2Fdone.example.com", 8192, 0) {
		t.Fatal("URL exceeded configured redirect depth")
	}
}

func TestURLCompletionBeforeAnswerAndNoWaiterRejection(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testURLConfig())
	responses := make(chan acpsdk.UnstableCreateElicitationResponse, 1)
	go func() {
		response, _ := client.UnstableCreateElicitation(context.Background(), fixtureURLRequest("https://auth.example.com/approve?state=SECRET_URL_CANARY"))
		responses <- response
	}()
	created := waitCreate(t, recorder)
	if created.Kind != "url" || created.Detail.URL == "" || created.Detail.ElicitationID != "remote-service-1" ||
		created.DeadlineAt > time.Now().Add(3*time.Second).UnixMilli() {
		t.Fatalf("bad URL request shape: kind=%q deadline=%d", created.Kind, created.DeadlineAt)
	}
	if status := host.ResolveAcpInteractionAnswer(created.InteractionID, "stale-generation",
		AcpInteractionAnswerDecision{Kind: "accepted", AnswerHash: strings.Repeat("a", 64)}); status != "stale_generation" {
		t.Fatalf("stale generation status = %q", status)
	}
	if err := client.UnstableCompleteElicitation(context.Background(), acpsdk.UnstableCompleteElicitationNotification{
		ElicitationId: "remote-service-1",
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case path := <-recorder.completions:
		if !strings.Contains(path, created.InteractionID) {
			t.Fatalf("completion path = %q", path)
		}
	case <-time.After(time.Second):
		t.Fatal("upstream completion did not reach Worker callback")
	}
	if err := client.UnstableCompleteElicitation(context.Background(), acpsdk.UnstableCompleteElicitationNotification{
		ElicitationId: "remote-service-1",
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-recorder.completions:
		t.Fatal("duplicate completion sent")
	case <-time.After(20 * time.Millisecond):
	}
	hash := sha256.Sum256([]byte("accepted"))
	decision := AcpInteractionAnswerDecision{Kind: "accepted", AnswerHash: hex.EncodeToString(hash[:])}
	if status := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation, decision); status != "consumed" {
		t.Fatalf("answer receipt = %s", status)
	}
	select {
	case response := <-responses:
		if response.Accept == nil {
			t.Fatalf("URL response = %+v", response)
		}
	case <-time.After(time.Second):
		t.Fatal("URL answer did not resume wrapper")
	}
	if status := host.ResolveAcpInteractionAnswer("unknown", created.Generation, decision); status != "no_waiter" {
		t.Fatalf("missing waiter status = %s", status)
	}
	// A second request cannot reuse the completed ID in the same generation:
	// a late duplicate notification from A would otherwise complete B.
	reused, err := client.UnstableCreateElicitation(context.Background(), fixtureURLRequest("https://auth.example.com/second"))
	if err != nil || reused.Cancel == nil {
		t.Fatalf("reused elicitation ID = %+v, %v", reused, err)
	}
	if err := client.UnstableCompleteElicitation(context.Background(), acpsdk.UnstableCompleteElicitationNotification{
		ElicitationId: "remote-service-1",
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-recorder.creates:
		t.Fatal("reused elicitation ID created a second Worker interaction")
	case <-recorder.completions:
		t.Fatal("late duplicate completion reached a second Worker interaction")
	case <-time.After(20 * time.Millisecond):
	}
}

func TestURLUTF16ElicitationIDBoundaryThroughCompletion(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testURLConfig())
	tooLong := fixtureURLRequest("https://auth.example.com/approve")
	tooLong.Url.ElicitationId = acpsdk.UnstableElicitationId(strings.Repeat("😀", 129))
	response, err := client.UnstableCreateElicitation(context.Background(), tooLong)
	if err != nil || response.Cancel == nil {
		t.Fatalf("129 astral ID should be cancelled: %+v, %v", response, err)
	}
	allowed := fixtureURLRequest("https://auth.example.com/approve")
	allowed.Url.ElicitationId = acpsdk.UnstableElicitationId(strings.Repeat("😀", 128))
	responses := make(chan acpsdk.UnstableCreateElicitationResponse, 1)
	go func() {
		result, _ := client.UnstableCreateElicitation(context.Background(), allowed)
		responses <- result
	}()
	created := waitCreate(t, recorder)
	if created.Detail.ElicitationID != string(allowed.Url.ElicitationId) {
		t.Fatal("128 astral ID was not preserved in encrypted create request")
	}
	if err := client.UnstableCompleteElicitation(context.Background(), acpsdk.UnstableCompleteElicitationNotification{
		ElicitationId: allowed.Url.ElicitationId,
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-recorder.completions:
	case <-time.After(time.Second):
		t.Fatal("128 astral ID did not complete")
	}
	hash := sha256.Sum256([]byte("accepted"))
	if status := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation,
		AcpInteractionAnswerDecision{Kind: "accepted", AnswerHash: hex.EncodeToString(hash[:])}); status != "consumed" {
		t.Fatalf("answer status = %s", status)
	}
	select {
	case result := <-responses:
		if result.Accept == nil {
			t.Fatalf("128 astral ID result = %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("128 astral ID did not return")
	}
}

func TestURLCompletionCallbackRetryStatus(t *testing.T) {
	for _, testCase := range []struct {
		name         string
		statuses     []int
		wantAttempts int
	}{
		{name: "bad request is terminal", statuses: []int{http.StatusBadRequest}, wantAttempts: 1},
		{name: "not found retries until create is visible", statuses: []int{http.StatusNotFound, http.StatusNoContent}, wantAttempts: 2},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := newInteractionRecorder(t, http.StatusCreated)
			host, _ := newInteractionHost(recorder)
			t.Cleanup(host.Stop)
			host.ConfigureAcpInteractions(testURLConfig())
			attempts := 0
			host.config.HTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				index := attempts
				attempts++
				if index >= len(testCase.statuses) {
					t.Fatal("unexpected retry")
				}
				return &http.Response{StatusCode: testCase.statuses[index], Body: io.NopCloser(strings.NewReader("")),
					Header: make(http.Header), Request: request}, nil
			})}
			host.completeURLInteraction(acpUrlElicitation{interactionID: "url-test", generation: host.interactionGeneration,
				deadline: time.Now().Add(time.Second)}, "fixture-id")
			if attempts != testCase.wantAttempts {
				t.Fatalf("callback attempts = %d, want %d", attempts, testCase.wantAttempts)
			}
		})
	}
}

func TestUnsupportedLoopbackURLDoesNotCreateInteraction(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testURLConfig())
	response, err := client.UnstableCreateElicitation(context.Background(), fixtureURLRequest(
		"https://auth.example.com/oauth?redirect_uri=http%3A%2F%2F127.0.0.1%3A7777%2Fcallback"))
	if err != nil || response.Cancel == nil {
		t.Fatalf("loopback response = %+v, %v", response, err)
	}
	select {
	case <-recorder.creates:
		t.Fatal("loopback request was created")
	default:
	}
}

func TestPinnedSDKURLRequestAndCompletionNotificationWire(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, _ := newInteractionHost(recorder)
	host.ConfigureAcpInteractions(testURLConfig())
	t.Cleanup(host.Stop)
	clientToAgentReader, clientToAgentWriter := io.Pipe()
	agentToClientReader, agentToClientWriter := io.Pipe()
	t.Cleanup(func() {
		_ = clientToAgentReader.Close()
		_ = clientToAgentWriter.Close()
		_ = agentToClientReader.Close()
		_ = agentToClientWriter.Close()
	})
	agent := &sdkURLFixtureAgent{observed: make(chan acpsdk.UnstableCreateElicitationResponse, 1)}
	agent.conn = acpsdk.NewAgentSideConnection(agent, agentToClientWriter, clientToAgentReader)
	client := &sessionHostClient{host: host, interactionGeneration: host.interactionGeneration}
	clientConn := acpsdk.NewClientSideConnection(client, clientToAgentWriter, agentToClientReader)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	promptDone := make(chan error, 1)
	go func() {
		_, err := clientConn.Prompt(ctx, acpsdk.PromptRequest{SessionId: "sdk-session", Prompt: []acpsdk.ContentBlock{acpsdk.TextBlock("test URL")}})
		promptDone <- err
	}()
	var created acpInteractionCreateRequest
	select {
	case created = <-recorder.creates:
	case err := <-promptDone:
		t.Fatalf("SDK prompt ended before URL create: %v", err)
	case <-ctx.Done():
		t.Fatal("SDK URL create timed out")
	}
	hash := sha256.Sum256([]byte("accepted"))
	if status := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation,
		AcpInteractionAnswerDecision{Kind: "accepted", AnswerHash: hex.EncodeToString(hash[:])}); status != "consumed" {
		t.Fatalf("SDK URL answer = %s", status)
	}
	select {
	case response := <-agent.observed:
		if response.Accept == nil {
			t.Fatalf("SDK URL response = %+v", response)
		}
	case <-ctx.Done():
		t.Fatal("SDK URL request did not resume")
	}
	select {
	case <-recorder.completions:
	case <-ctx.Done():
		t.Fatal("SDK completion notification did not reach Worker callback")
	}
	select {
	case err := <-promptDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("SDK prompt did not finish")
	}
}
