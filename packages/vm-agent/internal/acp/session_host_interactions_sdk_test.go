package acp

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

type sdkPermissionContextObservation struct {
	hasDeadline bool
	err         error
}

type sdkPermissionObservingClient struct {
	*sessionHostClient
	observed chan sdkPermissionContextObservation
}

func (c *sdkPermissionObservingClient) RequestPermission(
	ctx context.Context,
	params acpsdk.RequestPermissionRequest,
) (acpsdk.RequestPermissionResponse, error) {
	_, hasDeadline := ctx.Deadline()
	c.observed <- sdkPermissionContextObservation{hasDeadline: hasDeadline, err: ctx.Err()}
	return c.sessionHostClient.RequestPermission(ctx, params)
}

type sdkPermissionFixtureAgent struct {
	acpsdk.Agent
	conn *acpsdk.AgentSideConnection
}

func (a *sdkPermissionFixtureAgent) Initialize(
	context.Context,
	acpsdk.InitializeRequest,
) (acpsdk.InitializeResponse, error) {
	return acpsdk.InitializeResponse{
		ProtocolVersion:   acpsdk.ProtocolVersionNumber,
		AgentCapabilities: acpsdk.AgentCapabilities{},
	}, nil
}

func (a *sdkPermissionFixtureAgent) Cancel(context.Context, acpsdk.CancelNotification) error {
	return nil
}

func (a *sdkPermissionFixtureAgent) Prompt(
	ctx context.Context,
	params acpsdk.PromptRequest,
) (acpsdk.PromptResponse, error) {
	request := permissionRequest()
	request.SessionId = params.SessionId
	_, _ = a.conn.RequestPermission(ctx, request)
	return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
}

type sdkPermissionFixture struct {
	host       *SessionHost
	clientConn *acpsdk.ClientSideConnection
	observed   chan sdkPermissionContextObservation
}

func newSDKPermissionFixture(t *testing.T, recorder *interactionRecorder) *sdkPermissionFixture {
	t.Helper()
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		ControlPlaneURL: recorder.server.URL,
		ProjectID:       "project-1",
		WorkspaceID:     "workspace-1",
		SessionID:       "agent-session-1",
		RuntimeIdentity: "runtime-1",
		CallbackToken:   "callback-token",
		HTTPClient:      recorder.server.Client(),
	}})
	host.ConfigureAcpInteractions(testInteractionConfig())
	generation := host.attachAcpInteractionGeneration()

	clientToAgentReader, clientToAgentWriter := io.Pipe()
	agentToClientReader, agentToClientWriter := io.Pipe()
	t.Cleanup(func() {
		host.Stop()
		_ = clientToAgentReader.Close()
		_ = clientToAgentWriter.Close()
		_ = agentToClientReader.Close()
		_ = agentToClientWriter.Close()
	})

	agent := &sdkPermissionFixtureAgent{}
	agentConn := acpsdk.NewAgentSideConnection(agent, agentToClientWriter, clientToAgentReader)
	agent.conn = agentConn
	observed := make(chan sdkPermissionContextObservation, 4)
	client := &sdkPermissionObservingClient{
		sessionHostClient: &sessionHostClient{host: host, interactionGeneration: generation},
		observed:          observed,
	}
	return &sdkPermissionFixture{
		host:       host,
		clientConn: acpsdk.NewClientSideConnection(client, clientToAgentWriter, agentToClientReader),
		observed:   observed,
	}
}

func (f *sdkPermissionFixture) startPrompt(
	t *testing.T,
	ctx context.Context,
	cancel context.CancelFunc,
	deliveryID string,
) (*promptAttempt, <-chan error) {
	t.Helper()
	attempt, ok := f.host.beginPromptForDelivery(ctx, cancel, deliveryID, nil)
	if !ok {
		t.Fatal("SDK fixture prompt was not accepted")
	}
	done := make(chan error, 1)
	go func() {
		_, err := f.clientConn.Prompt(ctx, acpsdk.PromptRequest{
			SessionId: "sdk-session",
			Prompt:    []acpsdk.ContentBlock{acpsdk.TextBlock(deliveryID)},
		})
		attempt.complete(f.host, "fixture_complete", err)
		done <- err
	}()
	return attempt, done
}

func TestSDKPermissionUsesPromptAttemptDeadlineAndKeepsConnectionAlive(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	fixture := newSDKPermissionFixture(t, recorder)
	promptCtx, promptCancel := context.WithTimeout(fixture.host.lifecycleContext(), 80*time.Millisecond)
	defer promptCancel()
	_, promptDone := fixture.startPrompt(t, promptCtx, promptCancel, "deadline-attempt")
	created := waitCreate(t, recorder)

	observation := <-fixture.observed
	if observation.hasDeadline || observation.err != nil {
		t.Fatalf("SDK inbound permission context = %+v, want live context without prompt deadline", observation)
	}
	if settle := waitSettle(t, recorder); settle.InteractionID != created.InteractionID || settle.Reason != "expired" {
		t.Fatalf("deadline settle = %+v, want matching expired permission", settle)
	}
	select {
	case <-promptDone:
	case <-time.After(time.Second):
		t.Fatal("prompt deadline did not close the SDK prompt")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := fixture.clientConn.Initialize(ctx, acpsdk.InitializeRequest{ProtocolVersion: acpsdk.ProtocolVersionNumber}); err != nil {
		t.Fatalf("SDK connection did not survive permission deadline: %v", err)
	}
}

func TestSDKPermissionCancelIsAttemptScopedAcrossNextPrompt(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	fixture := newSDKPermissionFixture(t, recorder)

	firstCtx, firstCancel := context.WithCancel(fixture.host.lifecycleContext())
	firstAttempt, firstDone := fixture.startPrompt(t, firstCtx, firstCancel, "cancelled-attempt")
	first := waitCreate(t, recorder)
	<-fixture.observed
	fixture.host.CancelPrompt()
	if settle := waitSettle(t, recorder); settle.InteractionID != first.InteractionID || settle.Reason != "wrapper_cancelled" {
		t.Fatalf("cancel settle = %+v, want matching wrapper_cancelled permission", settle)
	}
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("prompt cancel did not close the first SDK prompt")
	}

	secondCtx, secondCancel := context.WithCancel(fixture.host.lifecycleContext())
	defer secondCancel()
	_, secondDone := fixture.startPrompt(t, secondCtx, secondCancel, "next-attempt")
	second := waitCreate(t, recorder)
	<-fixture.observed
	if fixture.host.cancelAcpInteractionWaiterForAttempt(
		second.InteractionID,
		second.Generation,
		firstAttempt.id,
		"wrapper_cancelled",
	) {
		t.Fatal("stale first-attempt cancellation claimed the next permission")
	}
	decision := AcpInteractionAnswerDecision{
		Kind: "selected_option", OptionID: "allow", AnswerHash: "second-answer",
	}
	if status := fixture.host.ResolveAcpInteractionAnswer(second.InteractionID, second.Generation, decision); status != "consumed" {
		t.Fatalf("second answer receipt = %q, want consumed", status)
	}
	if settle := waitSettle(t, recorder); settle.InteractionID != second.InteractionID || settle.Reason != "completed" {
		t.Fatalf("second settle = %+v, want matching completed permission", settle)
	}
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("next SDK prompt failed after stale cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("next SDK prompt did not complete")
	}
}
