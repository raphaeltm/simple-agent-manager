package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

type fakeCodexNativeRPC struct {
	thread        json.RawMessage
	resumed       string
	interrupted   string
	interruptedCh chan string
	closed        bool
	initializeErr error
	readHook      func()
	readSequence  uint64
	done          chan struct{}
	doneOnce      sync.Once
	closeOnce     sync.Once
}

type blockingMessageReporter struct {
	started chan struct{}
	release chan struct{}
	mu      sync.Mutex
	byID    map[string]MessageReportEntry
	calls   int
}

func (r *blockingMessageReporter) Enqueue(message MessageReportEntry) error {
	r.mu.Lock()
	r.calls++
	r.mu.Unlock()
	select {
	case r.started <- struct{}{}:
	default:
	}
	<-r.release
	r.mu.Lock()
	if r.byID == nil {
		r.byID = make(map[string]MessageReportEntry)
	}
	r.byID[message.MessageID] = message
	r.mu.Unlock()
	return nil
}

type idempotentMessageReporter struct {
	mu   sync.Mutex
	byID map[string]MessageReportEntry
}

func (r *idempotentMessageReporter) Enqueue(message MessageReportEntry) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.byID == nil {
		r.byID = make(map[string]MessageReportEntry)
	}
	r.byID[message.MessageID] = message
	return nil
}

func (f *fakeCodexNativeRPC) initialize(context.Context) error { return f.initializeErr }
func (f *fakeCodexNativeRPC) resumeThread(_ context.Context, id string) error {
	f.resumed = id
	return nil
}
func (f *fakeCodexNativeRPC) readThread(context.Context, string) (codexNativeSnapshot, error) {
	if f.readHook != nil {
		f.readHook()
	}
	return codexNativeSnapshot{Thread: f.thread, Sequence: f.readSequence}, nil
}
func (f *fakeCodexNativeRPC) interruptTurn(_ context.Context, _, turnID string) error {
	f.interrupted = turnID
	if f.interruptedCh != nil {
		f.interruptedCh <- turnID
	}
	return nil
}
func (f *fakeCodexNativeRPC) Done() <-chan struct{} {
	f.doneOnce.Do(func() { f.done = make(chan struct{}) })
	return f.done
}
func (f *fakeCodexNativeRPC) Err() error { return errors.New("fake connection closed") }
func (f *fakeCodexNativeRPC) Close() error {
	f.closed = true
	f.Done()
	f.closeOnce.Do(func() { close(f.done) })
	return nil
}

func TestResolveCodexSharedDaemonConfigIsOptInAndFenced(t *testing.T) {
	t.Parallel()
	startup := &agentStartup{envVars: []string{"HOME=/tmp/test-home"}}
	limits := (&SessionHost{}).codexSharedDaemonLimits()
	config, err := resolveCodexSharedDaemonConfig(startup, "sam", "/workspace", limits)
	if err != nil || config.enabled {
		t.Fatalf("default config = %#v, %v; want disabled", config, err)
	}

	startup.envVars = append(startup.envVars, codexSharedDaemonEnabledEnv+"=1", codexSharedDaemonSocketEnv+"=relative.sock")
	if _, err := resolveCodexSharedDaemonConfig(startup, "sam", "/workspace", limits); err == nil {
		t.Fatal("relative daemon socket was accepted")
	}
	startup.envVars[len(startup.envVars)-1] = codexSharedDaemonSocketEnv + "=/workspace/.sam/private.sock"
	config, err = resolveCodexSharedDaemonConfig(startup, "sam", "/workspace", limits)
	if err != nil || !config.enabled || config.dedupeLimit != defaultCodexNativeDedupeLimit {
		t.Fatalf("enabled config = %#v, %v", config, err)
	}
}

func TestResolveCodexSharedDaemonConfigRejectsInvalidLimits(t *testing.T) {
	t.Parallel()
	keys := []string{
		codexSharedDaemonHandshakeEnv,
		codexSharedDaemonRequestEnv,
		codexSharedDaemonWSBufferEnv,
		codexSharedDaemonReconnectDelayEnv,
		codexSharedDaemonReconnectTimeoutEnv,
		codexSharedDaemonMaxMessageEnv,
		codexSharedDaemonPingIntervalEnv,
		codexSharedDaemonPongTimeoutEnv,
		codexSharedDaemonDedupeLimitEnv,
	}
	for _, key := range keys {
		key := key
		t.Run(key, func(t *testing.T) {
			t.Parallel()
			startup := &agentStartup{envVars: []string{
				codexSharedDaemonEnabledEnv + "=1",
				codexSharedDaemonSocketEnv + "=/workspace/.sam/private.sock",
				key + "=0",
			}}
			if _, err := resolveCodexSharedDaemonConfig(startup, "sam", "/workspace", (&SessionHost{}).codexSharedDaemonLimits()); err == nil {
				t.Fatalf("%s accepted zero", key)
			}
		})
	}
}

func TestResolveCodexSharedDaemonConfigHonorsTrustedHostCeilings(t *testing.T) {
	t.Parallel()
	startup := &agentStartup{envVars: []string{
		codexSharedDaemonEnabledEnv + "=1",
		codexSharedDaemonSocketEnv + "=/workspace/.sam/private.sock",
		codexSharedDaemonWSBufferEnv + "=2048",
	}}
	limits := (&SessionHost{config: SessionHostConfig{GatewayConfig: GatewayConfig{
		CodexSharedDaemonMaxWebSocketBufferSize: 1024,
	}}}).codexSharedDaemonLimits()
	if _, err := resolveCodexSharedDaemonConfig(startup, "sam", "/workspace", limits); err == nil {
		t.Fatal("profile WebSocket buffer exceeded the trusted host ceiling")
	}
}

func TestResolveCodexSharedDaemonConfigClampsDefaultsToTrustedHostCeilings(t *testing.T) {
	t.Parallel()
	startup := &agentStartup{envVars: []string{
		codexSharedDaemonEnabledEnv + "=1",
		codexSharedDaemonSocketEnv + "=/workspace/.sam/private.sock",
	}}
	limits := codexSharedDaemonLimits{
		duration:            time.Millisecond,
		websocketBufferSize: 1024,
		messageBytes:        2048,
		dedupeLimit:         2,
	}
	config, err := resolveCodexSharedDaemonConfig(startup, "sam", "/workspace", limits)
	if err != nil {
		t.Fatal(err)
	}
	if config.handshakeTimeout != limits.duration || config.requestTimeout != limits.duration ||
		config.reconnectDelay != limits.duration || config.reconnectTimeout != limits.duration ||
		config.pingInterval != limits.duration || config.pongTimeout != limits.duration {
		t.Fatalf("duration defaults were not clamped: %#v", config)
	}
	if config.websocketBufferSize != limits.websocketBufferSize {
		t.Fatalf("websocket buffer = %d, want %d", config.websocketBufferSize, limits.websocketBufferSize)
	}
	if config.maxMessageBytes != limits.messageBytes {
		t.Fatalf("message bytes = %d, want %d", config.maxMessageBytes, limits.messageBytes)
	}
	if config.dedupeLimit != limits.dedupeLimit {
		t.Fatalf("dedupe limit = %d, want %d", config.dedupeLimit, limits.dedupeLimit)
	}
}

func TestConfigureCodexSharedDaemonDisabledPreservesStartup(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{ContainerWorkDir: "/workspace"}})
	defer host.Stop()
	startup := &agentStartup{envVars: []string{"CODEX_PATH=ordinary-codex", "SAM_MCP_IDENTITY=preserved"}}
	if err := host.configureCodexSharedDaemon(context.Background(), startup); err != nil {
		t.Fatal(err)
	}
	if got := envValue(startup.envVars, "CODEX_PATH"); got != "ordinary-codex" {
		t.Fatalf("CODEX_PATH=%q, want ordinary-codex", got)
	}
	if got := envValue(startup.envVars, "SAM_MCP_IDENTITY"); got != "preserved" {
		t.Fatalf("SAM_MCP_IDENTITY=%q, want preserved", got)
	}
	if host.sharedCodexDaemonEnabled() || host.codexNativeObserver != nil {
		t.Fatal("disabled configuration installed shared-daemon state")
	}
}

func TestCodexNativeObserverCapturesExternalItemsAndDeduplicatesReplay(t *testing.T) {
	t.Parallel()
	reporter := &mockMessageReporter{}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{MessageReporter: reporter}})
	defer host.Stop()
	observer := &codexNativeObserver{
		host: host, threadID: "thread-1", config: codexSharedDaemonConfig{dedupeLimit: 8},
		activeTurns: map[string]struct{}{}, approvals: map[string]struct{}{},
	}

	observer.handleEnvelope(nativeEnvelope(t, "turn/started", `{"threadId":"thread-1","turn":{"id":"turn-1","status":"inProgress","items":[]}}`))
	if work := host.harnessWorkSnapshot(); work.State != harnessWorkActive || work.Count != 1 || work.Source != codexNativeWorkSource {
		t.Fatalf("active native work = %#v", work)
	}
	user := `{"threadId":"thread-1","turnId":"turn-1","item":{"id":"user-1","type":"userMessage","content":[{"type":"text","text":"from native"}]}}`
	assistant := `{"threadId":"thread-1","turnId":"turn-1","item":{"id":"assistant-1","type":"agentMessage","text":"native answer"}}`
	tool := `{"threadId":"thread-1","turnId":"turn-1","item":{"id":"tool-1","type":"mcpToolCall","server":"sam-mcp","tool":"get_task","status":"completed"}}`
	observer.handleEnvelope(nativeEnvelope(t, "item/completed", user))
	observer.handleEnvelope(nativeEnvelope(t, "item/completed", assistant))
	observer.handleEnvelope(nativeEnvelope(t, "item/completed", tool))
	observer.handleEnvelope(nativeEnvelope(t, "item/completed", assistant))
	observer.handleEnvelope(nativeEnvelope(t, "item/completed", `{"threadId":"other","turnId":"turn-x","item":{"id":"foreign","type":"agentMessage","text":"no"}}`))

	messages := reporter.Messages()
	if len(messages) != 3 {
		t.Fatalf("persisted %d messages, want 3: %#v", len(messages), messages)
	}
	if messages[0].Role != "user" || messages[0].Content != "from native" {
		t.Fatalf("user message = %#v", messages[0])
	}
	if messages[1].Role != "assistant" || messages[1].Content != "native answer" {
		t.Fatalf("assistant message = %#v", messages[1])
	}
	if messages[2].Role != "tool" || messages[2].ToolMetadata == "" {
		t.Fatalf("tool message = %#v", messages[2])
	}
	if bufferedMessageCount(host) != 1 {
		t.Fatalf("buffered messages = %d, want external user only", bufferedMessageCount(host))
	}

	// A replacement observer replays history after reconnect. Host-scoped item
	// IDs prevent a second enqueue even though the connection-local state is new.
	replacement := &codexNativeObserver{host: host, threadID: "thread-1", config: codexSharedDaemonConfig{dedupeLimit: 8}, activeTurns: map[string]struct{}{}, approvals: map[string]struct{}{}}
	if err := replacement.reconcile(json.RawMessage(`{"id":"thread-1","turns":[{"id":"turn-1","status":"completed","items":[{"id":"assistant-1","type":"agentMessage","text":"native answer"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	if got := len(reporter.Messages()); got != 3 {
		t.Fatalf("replay persisted %d messages, want 3", got)
	}

	observer.handleEnvelope(nativeEnvelope(t, "turn/completed", `{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}`))
	if work := host.harnessWorkSnapshot(); work.Count != 0 {
		t.Fatalf("completed native work = %#v", work)
	}
}

func TestCodexNativeObserverLeavesApprovalOwnershipAndCanInterrupt(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	fake := &fakeCodexNativeRPC{}
	observer := &codexNativeObserver{host: host, threadID: "thread-1", config: codexSharedDaemonConfig{dedupeLimit: 8}, client: fake, activeTurns: map[string]struct{}{}, approvals: map[string]struct{}{}}
	host.codexNativeObserver = observer

	observer.handleEnvelope(codexNativeEnvelope{ID: json.RawMessage(`7`), Method: "item/commandExecution/requestApproval", Params: json.RawMessage(`{"threadId":"thread-1","turnId":"turn-1"}`)})
	if work := host.harnessWorkSnapshot(); work.Count != 1 {
		t.Fatalf("approval work = %#v", work)
	}
	// No observer response API exists: it records lifecycle only. Resolution from
	// the initiating client releases the activity edge.
	observer.handleEnvelope(nativeEnvelope(t, "serverRequest/resolved", `{"threadId":"thread-1","requestId":7}`))
	if work := host.harnessWorkSnapshot(); work.Count != 0 {
		t.Fatalf("resolved approval work = %#v", work)
	}

	observer.setTurn("turn-2", true)
	if !host.interruptCodexNativeTurn() || fake.interrupted != "turn-2" {
		t.Fatalf("interrupt = %q, want turn-2", fake.interrupted)
	}
}

func TestCodexNativeObserverReplacementRetainsGenerationScopedActivity(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	newObserver := func() *codexNativeObserver {
		return &codexNativeObserver{host: host, threadID: "thread-1", config: codexSharedDaemonConfig{dedupeLimit: 8}, activeTurns: map[string]struct{}{}, approvals: map[string]struct{}{}}
	}
	previous := newObserver()
	replacement := newObserver()
	thread := json.RawMessage(`{"id":"thread-1","turns":[{"id":"turn-1","status":"inProgress","items":[]}]}`)
	for _, observer := range []*codexNativeObserver{previous, replacement} {
		if err := observer.reconcile(thread); err != nil {
			t.Fatal(err)
		}
		observer.setApproval("request-1", true)
	}
	if work := host.harnessWorkSnapshot(); work.Count != 4 {
		t.Fatalf("overlapping observer activity = %#v, want four generation leases", work)
	}

	previous.close()
	if work := host.harnessWorkSnapshot(); work.State != harnessWorkActive || work.Count != 2 {
		t.Fatalf("replacement activity after previous close = %#v, want two leases", work)
	}
	replacement.close()
	if work := host.harnessWorkSnapshot(); work.Count != 0 {
		t.Fatalf("activity after both observers close = %#v", work)
	}
}

func TestStartCodexNativeObserverFailsClosedOnWrongThread(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	host.agentType = "openai-codex"
	host.setSessionIDLocked(acpsdk.SessionId("attributed"))
	host.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8})
	fake := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"unattributed","turns":[]}`)}
	host.codexNativeConnect = func(context.Context, codexSharedDaemonConfig, codexNativeEventHandler) (codexNativeRPC, error) {
		return fake, nil
	}
	if err := host.startCodexNativeObserver(context.Background()); err == nil {
		t.Fatal("wrong thread was attached")
	}
	if !fake.closed || fake.resumed != "attributed" {
		t.Fatalf("fake state = %#v", fake)
	}
}

func TestStartCodexNativeObserverFailsClosedOnInitializationError(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	host.agentType = "openai-codex"
	host.setSessionIDLocked("attributed")
	host.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8})
	fake := &fakeCodexNativeRPC{initializeErr: errors.New("version mismatch")}
	host.codexNativeConnect = func(context.Context, codexSharedDaemonConfig, codexNativeEventHandler) (codexNativeRPC, error) {
		return fake, nil
	}
	if err := host.startCodexNativeObserver(context.Background()); err == nil || !fake.closed {
		t.Fatalf("initialization failure = %v, closed=%v", err, fake.closed)
	}
}

func TestSharedDaemonMakesNativeObserverPersistenceAuthority(t *testing.T) {
	t.Parallel()
	reporter := &mockMessageReporter{}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{MessageReporter: reporter}})
	defer host.Stop()
	host.codexSharedDaemonEnabled.Store(true)
	client := &sessionHostClient{host: host}
	if err := client.SessionUpdate(context.Background(), agentMessageNotification("thread-1", "realtime")); err != nil {
		t.Fatal(err)
	}
	if got := len(reporter.Messages()); got != 0 {
		t.Fatalf("ACP stream persisted %d shared-mode messages", got)
	}
	if bufferedMessageCount(host) != 1 {
		t.Fatal("ACP realtime stream was not broadcast")
	}
}

func TestCodexNativeObserverRetriesEnqueueOnReplay(t *testing.T) {
	t.Parallel()
	reporter := &mockMessageReporter{errOnce: errors.New("outbox full")}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{MessageReporter: reporter}})
	defer host.Stop()
	observer := &codexNativeObserver{host: host, threadID: "thread-1", config: codexSharedDaemonConfig{dedupeLimit: 8}, activeTurns: map[string]struct{}{}, approvals: map[string]struct{}{}}
	item := codexNativeItem{ID: "assistant-1", Type: "agentMessage", Text: "retry me"}
	observer.persistItem(item, false)
	if got := len(reporter.Messages()); got != 0 {
		t.Fatalf("failed enqueue persisted %d messages", got)
	}
	observer.persistItem(item, false)
	if got := len(reporter.Messages()); got != 1 {
		t.Fatalf("replay persisted %d messages, want 1", got)
	}
}

func TestCodexNativeObserverReservesConcurrentPersistence(t *testing.T) {
	t.Parallel()
	reporter := &blockingMessageReporter{started: make(chan struct{}, 1), release: make(chan struct{})}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{MessageReporter: reporter}})
	defer host.Stop()
	observer := &codexNativeObserver{host: host, threadID: "thread-1", config: codexSharedDaemonConfig{dedupeLimit: 8}, activeTurns: map[string]struct{}{}, approvals: map[string]struct{}{}}
	item := codexNativeItem{ID: "assistant-1", Type: "agentMessage", Text: "once"}

	done := make(chan struct{})
	go func() {
		observer.persistItem(item, false)
		close(done)
	}()
	<-reporter.started
	observer.persistItem(item, false)
	close(reporter.release)
	<-done

	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	if reporter.calls != 1 || len(reporter.byID) != 1 {
		t.Fatalf("concurrent persistence calls=%d durable=%d, want 1/1", reporter.calls, len(reporter.byID))
	}
}

func TestCodexNativeObserverCloseDrainsPersistenceWithoutLateBroadcast(t *testing.T) {
	t.Parallel()
	reporter := &blockingMessageReporter{started: make(chan struct{}, 1), release: make(chan struct{})}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{MessageReporter: reporter}})
	defer host.Stop()
	observer := &codexNativeObserver{host: host, threadID: "thread-1", config: codexSharedDaemonConfig{dedupeLimit: 8}, activeTurns: map[string]struct{}{}, approvals: map[string]struct{}{}}
	event := nativeEnvelope(t, "item/completed", `{"threadId":"thread-1","turnId":"turn-1","item":{"id":"user-1","type":"userMessage","content":[{"type":"text","text":"late"}]}}`)

	eventDone := make(chan struct{})
	go func() {
		observer.handleEnvelope(event)
		close(eventDone)
	}()
	<-reporter.started
	closeDone := make(chan struct{})
	go func() {
		observer.close()
		close(closeDone)
	}()
	deadline := time.Now().Add(time.Second)
	for {
		observer.mu.Lock()
		closed := observer.closed
		observer.mu.Unlock()
		if closed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("observer did not enter close")
		}
		time.Sleep(time.Millisecond)
	}
	close(reporter.release)
	<-eventDone
	<-closeDone

	reporter.mu.Lock()
	durable := len(reporter.byID)
	reporter.mu.Unlock()
	if durable != 1 {
		t.Fatalf("durable messages=%d, want committed message", durable)
	}
	if got := bufferedMessageCount(host); got != 0 {
		t.Fatalf("post-close viewer messages=%d, want 0", got)
	}
}

func TestCodexNativeObserverLargeReplayUsesDurableMessageIDs(t *testing.T) {
	t.Parallel()
	const limit = 2
	reporter := &idempotentMessageReporter{}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{MessageReporter: reporter}})
	defer host.Stop()
	observer := &codexNativeObserver{host: host, threadID: "thread-1", config: codexSharedDaemonConfig{dedupeLimit: limit}, activeTurns: map[string]struct{}{}, approvals: map[string]struct{}{}}
	items := make([]codexNativeItem, 0, limit+1)
	for index := 0; index < limit+1; index++ {
		items = append(items, codexNativeItem{ID: fmt.Sprintf("item-%d", index), Type: "agentMessage", Text: "stable"})
	}
	thread, err := json.Marshal(codexNativeThread{ID: "thread-1", Turns: []codexNativeTurn{{ID: "turn-1", Status: "completed", Items: items}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := observer.reconcile(thread); err != nil {
		t.Fatal(err)
	}
	if err := observer.reconcile(thread); err != nil {
		t.Fatal(err)
	}
	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	if len(reporter.byID) != limit+1 {
		t.Fatalf("durable messages=%d, want %d", len(reporter.byID), limit+1)
	}
}

func TestCodexNativeObserverReconnectsAndReconciles(t *testing.T) {
	t.Parallel()
	reporter := &mockMessageReporter{}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{MessageReporter: reporter}})
	defer host.Stop()
	host.agentType = "openai-codex"
	host.setSessionIDLocked("thread-1")
	host.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8, requestTimeout: time.Second, reconnectDelay: time.Millisecond, reconnectTimeout: time.Second})
	first := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[]}`)}
	second := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[{"id":"turn-1","status":"completed","items":[{"id":"assistant-1","type":"agentMessage","text":"replayed"}]}]}`)}
	var connectMu sync.Mutex
	connectCount := 0
	host.codexNativeConnect = func(context.Context, codexSharedDaemonConfig, codexNativeEventHandler) (codexNativeRPC, error) {
		connectMu.Lock()
		defer connectMu.Unlock()
		connectCount++
		if connectCount == 1 {
			return first, nil
		}
		return second, nil
	}
	if err := host.startCodexNativeObserver(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(reporter.Messages()) == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if got := reporter.Messages(); len(got) != 1 || got[0].Content != "replayed" {
		t.Fatalf("reconciled messages = %#v", got)
	}
	host.codexNativeMu.Lock()
	connected := host.codexNativeObserver != nil && host.codexNativeObserver.client == second
	host.codexNativeMu.Unlock()
	if !connected {
		t.Fatal("observer did not install the replacement client")
	}
}

func TestCodexNativeObserverOrdersCompletionAfterInitialSnapshot(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	host.agentType = "openai-codex"
	host.setSessionIDLocked("thread-1")
	host.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8, requestTimeout: time.Second, reconnectDelay: time.Millisecond, reconnectTimeout: time.Second})
	client := &fakeCodexNativeRPC{
		thread:       json.RawMessage(`{"id":"thread-1","turns":[{"id":"turn-1","status":"inProgress","items":[]}]}`),
		readSequence: 1,
	}
	host.codexNativeConnect = func(_ context.Context, _ codexSharedDaemonConfig, handler codexNativeEventHandler) (codexNativeRPC, error) {
		client.readHook = func() {
			envelope := nativeEnvelope(t, "turn/completed", `{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}`)
			envelope.Sequence = 2
			handler(envelope)
		}
		return client, nil
	}
	if err := host.startCodexNativeObserver(context.Background()); err != nil {
		t.Fatal(err)
	}
	if work := host.harnessWorkSnapshot(); work.Count != 0 {
		t.Fatalf("completion after initial snapshot left stale work: %#v", work)
	}
}

func TestCodexNativeObserverSnapshotSupersedesCoveredPreResponseEvent(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	host.agentType = "openai-codex"
	host.setSessionIDLocked("thread-1")
	host.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8, requestTimeout: time.Second, reconnectDelay: time.Millisecond, reconnectTimeout: time.Second})
	client := &fakeCodexNativeRPC{
		thread:       json.RawMessage(`{"id":"thread-1","turns":[{"id":"turn-1","status":"completed","items":[]}]}`),
		readSequence: 2,
	}
	host.codexNativeConnect = func(_ context.Context, _ codexSharedDaemonConfig, handler codexNativeEventHandler) (codexNativeRPC, error) {
		client.readHook = func() {
			envelope := nativeEnvelope(t, "turn/started", `{"threadId":"thread-1","turn":{"id":"turn-1","status":"inProgress","items":[]}}`)
			envelope.Sequence = 1
			handler(envelope)
		}
		return client, nil
	}
	if err := host.startCodexNativeObserver(context.Background()); err != nil {
		t.Fatal(err)
	}
	if work := host.harnessWorkSnapshot(); work.Count != 0 {
		t.Fatalf("pre-response event overrode newer terminal snapshot: %#v", work)
	}
}

func TestCodexNativeObserverPreservesApprovalOutsideSnapshot(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	host.agentType = "openai-codex"
	host.setSessionIDLocked("thread-1")
	host.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8, requestTimeout: time.Second, reconnectDelay: time.Millisecond, reconnectTimeout: time.Second})
	client := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[]}`), readSequence: 2}
	host.codexNativeConnect = func(_ context.Context, _ codexSharedDaemonConfig, handler codexNativeEventHandler) (codexNativeRPC, error) {
		client.readHook = func() {
			handler(codexNativeEnvelope{
				Sequence: 1,
				ID:       json.RawMessage(`7`),
				Method:   "item/commandExecution/requestApproval",
				Params:   json.RawMessage(`{"threadId":"thread-1","turnId":"turn-1"}`),
			})
		}
		return client, nil
	}
	if err := host.startCodexNativeObserver(context.Background()); err != nil {
		t.Fatal(err)
	}
	if work := host.harnessWorkSnapshot(); work.Count != 1 {
		t.Fatalf("pre-snapshot approval work = %#v, want one active request", work)
	}
}

func TestCodexNativeObserverFailsClosedOnReconciliationEventCountOverflow(t *testing.T) {
	t.Parallel()
	reporter := &blockingMessageReporter{started: make(chan struct{}, 1), release: make(chan struct{})}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{MessageReporter: reporter}})
	defer host.Stop()
	observer := &codexNativeObserver{
		host: host, threadID: "thread-1",
		config:      codexSharedDaemonConfig{dedupeLimit: 1, maxMessageBytes: defaultCodexNativeMaxMessageBytes},
		activeTurns: map[string]struct{}{}, approvals: map[string]struct{}{},
	}
	generation, ok := observer.beginConnectionGeneration()
	if !ok {
		t.Fatal("observer did not start reconciliation generation")
	}
	first := nativeEnvelope(t, "item/completed", `{"threadId":"thread-1","turnId":"turn-1","item":{"id":"assistant-1","type":"agentMessage","text":"first"}}`)
	first.Sequence = 1
	observer.handleEnvelopeForGeneration(generation, first)
	errCh := make(chan error, 1)
	go func() {
		errCh <- observer.reconcileGeneration(codexNativeSnapshot{Thread: json.RawMessage(`{"id":"thread-1","turns":[]}`)}, generation)
	}()
	<-reporter.started
	second := nativeEnvelope(t, "item/completed", `{"threadId":"thread-1","turnId":"turn-1","item":{"id":"assistant-2","type":"agentMessage","text":"second"}}`)
	second.Sequence = 2
	observer.handleEnvelopeForGeneration(generation, second)
	close(reporter.release)
	err := <-errCh
	if err == nil || !strings.Contains(err.Error(), "event limit") {
		t.Fatalf("count overflow error = %v", err)
	}
	observer.mu.Lock()
	if len(observer.queuedEvents) != 0 || observer.queuedEventCount != 1 || observer.queuedEventBytes <= 0 {
		t.Fatalf("bounded count queue = len:%d count:%d bytes:%d", len(observer.queuedEvents), observer.queuedEventCount, observer.queuedEventBytes)
	}
	observer.mu.Unlock()

	nextGeneration, ok := observer.beginConnectionGeneration()
	if !ok || nextGeneration == generation {
		t.Fatal("observer did not reset into a new generation")
	}
	observer.mu.Lock()
	if len(observer.queuedEvents) != 0 || observer.queuedEventCount != 0 || observer.queuedEventBytes != 0 || observer.queuedEventErr != nil {
		t.Fatalf("new generation retained overflow state: len:%d count:%d bytes:%d err:%v", len(observer.queuedEvents), observer.queuedEventCount, observer.queuedEventBytes, observer.queuedEventErr)
	}
	observer.mu.Unlock()
	observer.close()
}

func TestCodexNativeObserverFailsClosedOnReconciliationByteOverflow(t *testing.T) {
	t.Parallel()
	reporter := &blockingMessageReporter{started: make(chan struct{}, 1), release: make(chan struct{})}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{MessageReporter: reporter}})
	defer host.Stop()
	first := nativeEnvelope(t, "item/completed", `{"threadId":"thread-1","turnId":"turn-1","item":{"id":"assistant-1","type":"agentMessage","text":"first payload"}}`)
	first.Sequence = 1
	second := nativeEnvelope(t, "item/completed", `{"threadId":"thread-1","turnId":"turn-1","item":{"id":"assistant-2","type":"agentMessage","text":"second payload"}}`)
	second.Sequence = 2
	firstBytes := codexNativeEnvelopeRetainedBytes(first)
	byteLimit := firstBytes + codexNativeEnvelopeRetainedBytes(second) - 1
	observer := &codexNativeObserver{
		host: host, threadID: "thread-1",
		config:      codexSharedDaemonConfig{dedupeLimit: defaultCodexNativeDedupeLimit, maxMessageBytes: byteLimit},
		activeTurns: map[string]struct{}{}, approvals: map[string]struct{}{},
	}
	generation, ok := observer.beginConnectionGeneration()
	if !ok {
		t.Fatal("observer did not start reconciliation generation")
	}
	observer.handleEnvelopeForGeneration(generation, first)
	errCh := make(chan error, 1)
	go func() {
		errCh <- observer.reconcileGeneration(codexNativeSnapshot{Thread: json.RawMessage(`{"id":"thread-1","turns":[]}`)}, generation)
	}()
	<-reporter.started
	observer.handleEnvelopeForGeneration(generation, second)
	close(reporter.release)
	err := <-errCh
	if err == nil || !strings.Contains(err.Error(), "retained byte limit") {
		t.Fatalf("byte overflow error = %v", err)
	}
	observer.mu.Lock()
	if len(observer.queuedEvents) != 0 || observer.queuedEventCount != 1 || observer.queuedEventBytes != firstBytes {
		t.Fatalf("byte overflow retained rejected event: len:%d count:%d bytes:%d", len(observer.queuedEvents), observer.queuedEventCount, observer.queuedEventBytes)
	}
	observer.mu.Unlock()
	observer.close()
	observer.mu.Lock()
	defer observer.mu.Unlock()
	if observer.queuedEventErr != nil || observer.queuedEventCount != 0 || observer.queuedEventBytes != 0 {
		t.Fatalf("close retained overflow state: count:%d bytes:%d err:%v", observer.queuedEventCount, observer.queuedEventBytes, observer.queuedEventErr)
	}
}

func TestCodexNativeObserverOrdersCompletionAfterReconnectSnapshot(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	host.agentType = "openai-codex"
	host.setSessionIDLocked("thread-1")
	host.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8, requestTimeout: time.Second, reconnectDelay: time.Millisecond, reconnectTimeout: time.Second})
	first := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[]}`)}
	second := &fakeCodexNativeRPC{
		thread:       json.RawMessage(`{"id":"thread-1","turns":[{"id":"turn-1","status":"inProgress","items":[]}]}`),
		readSequence: 1,
	}
	completionQueued := make(chan struct{})
	connectCount := 0
	host.codexNativeConnect = func(_ context.Context, _ codexSharedDaemonConfig, handler codexNativeEventHandler) (codexNativeRPC, error) {
		connectCount++
		if connectCount == 1 {
			return first, nil
		}
		second.readHook = func() {
			envelope := nativeEnvelope(t, "turn/completed", `{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}`)
			envelope.Sequence = 2
			handler(envelope)
			close(completionQueued)
		}
		return second, nil
	}
	if err := host.startCodexNativeObserver(context.Background()); err != nil {
		t.Fatal(err)
	}
	_ = first.Close()
	select {
	case <-completionQueued:
	case <-time.After(time.Second):
		t.Fatal("reconnect did not queue completion after snapshot")
	}
	waitForCodexNativeWorkCount(t, host, 0)
}

func TestCodexNativeObserverDiscardsFailedReconnectGeneration(t *testing.T) {
	t.Parallel()
	reporter := &mockMessageReporter{}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{MessageReporter: reporter}})
	defer host.Stop()
	host.agentType = "openai-codex"
	host.setSessionIDLocked("thread-1")
	host.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8, requestTimeout: time.Second, reconnectDelay: time.Millisecond, reconnectTimeout: time.Second})
	first := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[]}`)}
	failed := &fakeCodexNativeRPC{initializeErr: errors.New("failed attempt")}
	final := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[{"id":"turn-1","status":"completed","items":[]}]}`)}
	connected := make(chan struct{})
	connectCount := 0
	host.codexNativeConnect = func(_ context.Context, _ codexSharedDaemonConfig, handler codexNativeEventHandler) (codexNativeRPC, error) {
		connectCount++
		switch connectCount {
		case 1:
			return first, nil
		case 2:
			envelope := nativeEnvelope(t, "item/completed", `{"threadId":"thread-1","turnId":"failed-turn","item":{"id":"failed-generation-assistant","type":"agentMessage","text":"must not persist"}}`)
			envelope.Sequence = 1
			handler(envelope)
			return failed, nil
		default:
			close(connected)
			return final, nil
		}
	}
	if err := host.startCodexNativeObserver(context.Background()); err != nil {
		t.Fatal(err)
	}
	_ = first.Close()
	select {
	case <-connected:
	case <-time.After(time.Second):
		t.Fatal("observer did not reach the successful reconnect generation")
	}
	waitForCodexNativeWorkCount(t, host, 0)
	if messages := reporter.Messages(); len(messages) != 0 {
		t.Fatalf("failed reconnect generation persisted messages: %#v", messages)
	}
}

func TestCodexNativeObserverDeliversQueuedCancelAfterReconnect(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	host.agentType = "openai-codex"
	host.setSessionIDLocked("thread-1")
	host.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8, requestTimeout: time.Second, reconnectDelay: time.Millisecond, reconnectTimeout: time.Second})
	first := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[]}`)}
	second := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[{"id":"turn-1","status":"inProgress","items":[]}]}`), interruptedCh: make(chan string, 1)}
	reconnectStarted := make(chan struct{})
	releaseReconnect := make(chan struct{})
	connectCount := 0
	host.codexNativeConnect = func(context.Context, codexSharedDaemonConfig, codexNativeEventHandler) (codexNativeRPC, error) {
		connectCount++
		if connectCount == 1 {
			return first, nil
		}
		close(reconnectStarted)
		<-releaseReconnect
		return second, nil
	}
	if err := host.startCodexNativeObserver(context.Background()); err != nil {
		t.Fatal(err)
	}
	host.codexNativeObserver.setTurn("turn-1", true)
	_ = first.Close()
	<-reconnectStarted
	if !host.scheduleCodexNativeInterrupt() {
		t.Fatal("cancel was not queued during reconnect")
	}
	close(releaseReconnect)
	select {
	case interrupted := <-second.interruptedCh:
		if interrupted != "turn-1" {
			t.Fatalf("interrupted=%q, want turn-1", interrupted)
		}
	case <-time.After(time.Second):
		t.Fatal("queued cancel was not delivered after reconnect")
	}
}

func TestCodexNativeObserverReconnectReconcilesActiveWorkAndApprovals(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	host.agentType = "openai-codex"
	host.setSessionIDLocked("thread-1")
	host.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8, requestTimeout: time.Second, reconnectDelay: time.Millisecond, reconnectTimeout: time.Second})
	first := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[]}`)}
	second := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[{"id":"turn-1","status":"completed","items":[]}]}`)}
	connectCount := 0
	host.codexNativeConnect = func(context.Context, codexSharedDaemonConfig, codexNativeEventHandler) (codexNativeRPC, error) {
		connectCount++
		if connectCount == 1 {
			return first, nil
		}
		return second, nil
	}
	if err := host.startCodexNativeObserver(context.Background()); err != nil {
		t.Fatal(err)
	}
	host.codexNativeObserver.setTurn("turn-1", true)
	host.codexNativeObserver.setApproval("approval-1", true)
	_ = first.Close()
	waitForCodexNativeWorkCount(t, host, 0)
}

func TestCodexNativeObserverReconnectExhaustionClearsActiveWork(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	host.agentType = "openai-codex"
	host.setSessionIDLocked("thread-1")
	host.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8, requestTimeout: time.Second, reconnectDelay: time.Millisecond, reconnectTimeout: 10 * time.Millisecond})
	first := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[]}`)}
	connectCount := 0
	host.codexNativeConnect = func(context.Context, codexSharedDaemonConfig, codexNativeEventHandler) (codexNativeRPC, error) {
		connectCount++
		if connectCount == 1 {
			return first, nil
		}
		return nil, errors.New("daemon unavailable")
	}
	if err := host.startCodexNativeObserver(context.Background()); err != nil {
		t.Fatal(err)
	}
	host.codexNativeObserver.setTurn("turn-1", true)
	host.codexNativeObserver.setApproval("approval-1", true)
	_ = first.Close()
	waitForCodexNativeWorkCount(t, host, 0)
}

func TestClosedReconnectingObserverCannotAffectReplacement(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	process, _, _ := newFakeAgentProcess(time.Now(), false)
	host.process = process
	oldClient := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[]}`)}
	started := make(chan struct{})
	release := make(chan struct{})
	old := &codexNativeObserver{
		host: host, threadID: "thread-1",
		config: codexSharedDaemonConfig{dedupeLimit: 8, reconnectDelay: time.Millisecond, reconnectTimeout: 50 * time.Millisecond},
		client: oldClient, activeTurns: map[string]struct{}{"turn-1": {}}, approvals: map[string]struct{}{},
		connect: func(context.Context, codexSharedDaemonConfig, codexNativeEventHandler) (codexNativeRPC, error) {
			select {
			case <-started:
			default:
				close(started)
			}
			<-release
			return nil, errors.New("old connector released")
		},
	}
	host.codexNativeObserver = old
	go old.monitorClient(host.lifecycleContext(), oldClient)
	_ = oldClient.Close()
	<-started
	replacement := &codexNativeObserver{host: host, threadID: "thread-2", config: codexSharedDaemonConfig{dedupeLimit: 8}, activeTurns: map[string]struct{}{}, approvals: map[string]struct{}{}}
	host.codexNativeMu.Lock()
	host.codexNativeObserver = replacement
	host.codexNativeMu.Unlock()
	old.close()
	close(release)
	time.Sleep(75 * time.Millisecond)
	if got := process.stopCount.Load(); got != 0 {
		t.Fatalf("replacement ACP process stop count=%d, want 0", got)
	}
	if work := host.harnessWorkSnapshot(); work.Count != 0 {
		t.Fatalf("stale observer resurrected work: %#v", work)
	}
	host.codexNativeMu.Lock()
	current := host.codexNativeObserver
	host.codexNativeMu.Unlock()
	if current != replacement {
		t.Fatal("stale observer replaced current generation")
	}
}

func TestCodexNativeObserverSuspendResumePreservesIdentityWorkspaceAndDedupe(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	path := filepath.Join(workspace, "uncommitted.txt")
	if err := os.WriteFile(path, []byte("uncommitted\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	reporter := &idempotentMessageReporter{}
	firstHost := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{MessageReporter: reporter, ContainerWorkDir: workspace}})
	firstHost.agentType = "openai-codex"
	firstHost.setSessionIDLocked("thread-1")
	firstHost.setStatusLocked(HostReady)
	firstClient := &fakeCodexNativeRPC{thread: json.RawMessage(`{"id":"thread-1","turns":[{"id":"turn-1","status":"completed","items":[{"id":"assistant-1","type":"agentMessage","text":"persisted"}]}]}`)}
	firstHost.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8, requestTimeout: time.Second, reconnectDelay: time.Millisecond, reconnectTimeout: time.Second})
	firstHost.codexNativeConnect = func(context.Context, codexSharedDaemonConfig, codexNativeEventHandler) (codexNativeRPC, error) {
		return firstClient, nil
	}
	if err := firstHost.startCodexNativeObserver(context.Background()); err != nil {
		t.Fatal(err)
	}
	threadID, agentType := firstHost.Suspend()
	if threadID != "thread-1" || agentType != "openai-codex" || !firstClient.closed {
		t.Fatalf("suspend identity=%q agent=%q clientClosed=%t", threadID, agentType, firstClient.closed)
	}

	secondHost := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{MessageReporter: reporter, ContainerWorkDir: workspace}})
	defer secondHost.Stop()
	secondHost.agentType = agentType
	secondHost.setSessionIDLocked(acpsdk.SessionId(threadID))
	secondHost.setCodexSharedDaemonConfig(codexSharedDaemonConfig{enabled: true, dedupeLimit: 8, requestTimeout: time.Second, reconnectDelay: time.Millisecond, reconnectTimeout: time.Second})
	secondClient := &fakeCodexNativeRPC{thread: firstClient.thread}
	secondHost.codexNativeConnect = func(context.Context, codexSharedDaemonConfig, codexNativeEventHandler) (codexNativeRPC, error) {
		return secondClient, nil
	}
	if err := secondHost.startCodexNativeObserver(context.Background()); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != "uncommitted\n" {
		t.Fatalf("workspace content=%q err=%v", content, err)
	}
	if secondClient.resumed != threadID {
		t.Fatalf("resumed thread=%q, want %q", secondClient.resumed, threadID)
	}
	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	if len(reporter.byID) != 1 {
		t.Fatalf("durable replay messages=%d, want 1", len(reporter.byID))
	}
}

func TestClosedCodexNativeObserverCannotResurrectWork(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	observer := &codexNativeObserver{host: host, threadID: "thread-1", config: codexSharedDaemonConfig{dedupeLimit: 8}, activeTurns: map[string]struct{}{}, approvals: map[string]struct{}{}}
	observer.close()
	observer.setTurn("late-turn", true)
	observer.setApproval("late-approval", true)
	if work := host.harnessWorkSnapshot(); work.Count != 0 {
		t.Fatalf("closed observer work = %#v", work)
	}
}

func TestSharedDaemonCancelsUnattributedPermissionRequest(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	host.codexSharedDaemonEnabled.Store(true)
	response, err := (&sessionHostClient{host: host}).RequestPermission(context.Background(), acpsdk.RequestPermissionRequest{
		Options: []acpsdk.PermissionOption{{OptionId: "allow"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.Outcome.Cancelled == nil {
		t.Fatalf("permission outcome = %#v, want cancelled", response.Outcome)
	}
}

func TestSharedDaemonCancelsPermissionDuringSAMPrompt(t *testing.T) {
	t.Parallel()
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	host.codexSharedDaemonEnabled.Store(true)
	host.promptMu.Lock()
	host.promptInFlight = true
	host.promptMu.Unlock()
	response, err := (&sessionHostClient{host: host}).RequestPermission(context.Background(), acpsdk.RequestPermissionRequest{
		Options: []acpsdk.PermissionOption{{OptionId: "allow"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.Outcome.Cancelled == nil {
		t.Fatalf("permission outcome = %#v, want fail-closed cancellation", response.Outcome)
	}
}

func TestCancelPromptEntryPointsInterruptExternalTurnWithoutStoppingACP(t *testing.T) {
	t.Parallel()
	for _, cancel := range []struct {
		name string
		call func(*SessionHost)
	}{
		{name: "viewer", call: (*SessionHost).CancelPrompt},
		{name: "control-plane", call: (*SessionHost).CancelPromptFromControlPlane},
	} {
		t.Run(cancel.name, func(t *testing.T) {
			host := NewSessionHost(SessionHostConfig{})
			defer host.Stop()
			process, _, _ := newFakeAgentProcess(time.Now(), false)
			host.process = process
			host.agentType = "openai-codex"
			fake := &fakeCodexNativeRPC{interruptedCh: make(chan string, 1)}
			observer := &codexNativeObserver{host: host, threadID: "thread-1", config: codexSharedDaemonConfig{requestTimeout: time.Second}, client: fake, activeTurns: map[string]struct{}{"turn-1": {}}, approvals: map[string]struct{}{}}
			host.codexNativeObserver = observer
			cancel.call(host)
			select {
			case interrupted := <-fake.interruptedCh:
				if interrupted != "turn-1" {
					t.Fatalf("interrupted=%q, want turn-1", interrupted)
				}
			case <-time.After(time.Second):
				t.Fatal("native interrupt was not sent")
			}
			if got := process.stopCount.Load(); got != 0 {
				t.Fatalf("ACP process stop count=%d, want 0", got)
			}
		})
	}
}

func waitForCodexNativeWorkCount(t *testing.T, host *SessionHost, count int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if host.harnessWorkSnapshot().Count == count {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("native work = %#v, want count %d", host.harnessWorkSnapshot(), count)
}

func nativeEnvelope(t *testing.T, method, params string) codexNativeEnvelope {
	t.Helper()
	if !json.Valid([]byte(params)) {
		t.Fatalf("invalid test JSON: %s", params)
	}
	return codexNativeEnvelope{Method: method, Params: json.RawMessage(params)}
}
