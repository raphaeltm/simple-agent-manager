package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

const codexNativeConnectionWorkPrefix = "connection:"

type codexNativeRPC interface {
	initialize(context.Context) error
	resumeThread(context.Context, string) error
	readThread(context.Context, string) (json.RawMessage, error)
	interruptTurn(context.Context, string, string) error
	Done() <-chan struct{}
	Err() error
	Close() error
}

type codexNativeConnectFunc func(context.Context, codexSharedDaemonConfig, codexNativeEventHandler) (codexNativeRPC, error)

type codexNativeObserver struct {
	host     *SessionHost
	threadID string
	config   codexSharedDaemonConfig
	connect  codexNativeConnectFunc

	mu               sync.Mutex
	events           sync.WaitGroup
	client           codexNativeRPC
	activeTurns      map[string]struct{}
	approvals        map[string]struct{}
	reconnecting     bool
	pendingInterrupt bool
	closed           bool
}

type codexNativeThread struct {
	ID    string            `json:"id"`
	Turns []codexNativeTurn `json:"turns"`
}

type codexNativeTurn struct {
	ID     string            `json:"id"`
	Status string            `json:"status"`
	Items  []codexNativeItem `json:"items"`
}

type codexNativeItem struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Text    string          `json:"text,omitempty"`
	Content json.RawMessage `json:"content,omitempty"`
	Status  string          `json:"status,omitempty"`
	Command string          `json:"command,omitempty"`
	Server  string          `json:"server,omitempty"`
	Tool    string          `json:"tool,omitempty"`
}

type codexNativeNotification struct {
	ThreadID  string          `json:"threadId"`
	TurnID    string          `json:"turnId,omitempty"`
	Turn      codexNativeTurn `json:"turn,omitempty"`
	Item      codexNativeItem `json:"item,omitempty"`
	RequestID json.RawMessage `json:"requestId,omitempty"`
}

func defaultCodexNativeConnect(ctx context.Context, config codexSharedDaemonConfig, handler codexNativeEventHandler) (codexNativeRPC, error) {
	return connectCodexNativeClient(ctx, config, handler)
}

func (h *SessionHost) startCodexNativeObserver(ctx context.Context) error {
	if !h.sharedCodexDaemonEnabled() || h.agentType != "openai-codex" {
		return nil
	}
	threadID := string(h.sessionID)
	if threadID == "" {
		return fmt.Errorf("shared-daemon observer requires an attributed Codex thread")
	}

	h.codexNativeMu.Lock()
	config := h.codexSharedDaemon
	connect := h.codexNativeConnect
	h.codexNativeMu.Unlock()
	if connect == nil {
		connect = defaultCodexNativeConnect
	}
	observer := &codexNativeObserver{
		host: h, threadID: threadID, config: config, connect: connect,
		activeTurns: make(map[string]struct{}), approvals: make(map[string]struct{}),
	}
	client, err := connect(h.lifecycleContext(), config, observer.handleEnvelope)
	if err != nil {
		return fmt.Errorf("connect shared-daemon observer: %w", err)
	}
	observer.client = client
	if err := client.initialize(ctx); err != nil {
		_ = client.Close()
		return fmt.Errorf("initialize shared-daemon observer: %w", err)
	}
	if err := client.resumeThread(ctx, threadID); err != nil {
		_ = client.Close()
		return fmt.Errorf("resume attributed Codex thread: %w", err)
	}
	thread, err := client.readThread(ctx, threadID)
	if err != nil {
		_ = client.Close()
		return fmt.Errorf("read attributed Codex thread: %w", err)
	}
	if err := observer.reconcileGuarded(thread); err != nil {
		_ = client.Close()
		return fmt.Errorf("reconcile attributed Codex thread: %w", err)
	}

	h.codexNativeMu.Lock()
	previous := h.codexNativeObserver
	h.codexNativeObserver = observer
	h.codexNativeMu.Unlock()
	if previous != nil {
		previous.close()
	}
	h.reportLifecycle("info", "Codex shared-daemon observer attached", map[string]interface{}{"threadId": threadID})
	go observer.monitorClient(h.lifecycleContext(), client)
	return nil
}

func (h *SessionHost) stopCodexNativeObserver() {
	h.codexNativeMu.Lock()
	observer := h.codexNativeObserver
	h.codexNativeObserver = nil
	h.codexNativeMu.Unlock()
	if observer != nil {
		observer.close()
	}
}

func (o *codexNativeObserver) close() {
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return
	}
	o.closed = true
	o.reconnecting = false
	o.pendingInterrupt = false
	client := o.client
	workIDs := make([]string, 0, len(o.activeTurns)+len(o.approvals))
	for id := range o.activeTurns {
		workIDs = append(workIDs, o.turnWorkID(id))
	}
	for id := range o.approvals {
		workIDs = append(workIDs, o.approvalWorkID(id))
	}
	o.activeTurns = make(map[string]struct{})
	o.approvals = make(map[string]struct{})
	for _, id := range workIDs {
		o.host.applyCodexNativeWork(id, false)
	}
	o.host.applyCodexNativeWork(o.connectionWorkID(), false)
	o.mu.Unlock()
	o.host.nudgeHarnessActivityReport()
	if client != nil {
		_ = client.Close()
	}
	o.events.Wait()
}

func (o *codexNativeObserver) handleEnvelope(envelope codexNativeEnvelope) {
	if !o.beginOperation() {
		return
	}
	defer o.endOperation()
	var params codexNativeNotification
	if err := json.Unmarshal(envelope.Params, &params); err != nil {
		slog.Warn("Codex shared-daemon observer ignored malformed event", "method", envelope.Method)
		return
	}
	if params.ThreadID != o.threadID {
		return
	}
	switch envelope.Method {
	case "turn/started":
		o.setTurn(params.Turn.ID, true)
	case "turn/completed":
		o.setTurn(params.Turn.ID, false)
		for _, item := range params.Turn.Items {
			o.persistItem(item, true)
		}
	case "item/completed":
		o.persistItem(params.Item, true)
	case "serverRequest/resolved":
		o.setApproval(string(params.RequestID), false)
	default:
		// Approval requests are deliberately observed but never answered. The
		// client which started the turn remains the decision owner.
		if len(envelope.ID) > 0 && strings.Contains(strings.ToLower(envelope.Method), "approval") {
			o.setApproval(string(envelope.ID), true)
		}
	}
}

func (o *codexNativeObserver) beginOperation() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return false
	}
	o.events.Add(1)
	return true
}

func (o *codexNativeObserver) endOperation() {
	o.events.Done()
}

func (o *codexNativeObserver) reconcileGuarded(raw json.RawMessage) error {
	if !o.beginOperation() {
		return context.Canceled
	}
	defer o.endOperation()
	return o.reconcile(raw)
}

func (o *codexNativeObserver) reconcile(raw json.RawMessage) error {
	var thread codexNativeThread
	if err := json.Unmarshal(raw, &thread); err != nil {
		return err
	}
	if thread.ID != o.threadID {
		return fmt.Errorf("thread/read returned %q, want %q", thread.ID, o.threadID)
	}
	for _, turn := range thread.Turns {
		o.setTurn(turn.ID, turn.Status == "inProgress")
		for _, item := range turn.Items {
			o.persistItem(item, false)
		}
	}
	return nil
}

func (o *codexNativeObserver) setTurn(turnID string, active bool) {
	if turnID == "" {
		return
	}
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return
	}
	_, existed := o.activeTurns[turnID]
	if active {
		o.activeTurns[turnID] = struct{}{}
	} else {
		delete(o.activeTurns, turnID)
	}
	if existed == active {
		o.mu.Unlock()
		return
	}
	changed := o.host.applyCodexNativeWork(o.turnWorkID(turnID), active)
	o.mu.Unlock()
	if changed {
		o.host.nudgeHarnessActivityReport()
	}
}

func (o *codexNativeObserver) setApproval(requestID string, active bool) {
	if requestID == "" || requestID == "null" {
		return
	}
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return
	}
	_, existed := o.approvals[requestID]
	if active {
		o.approvals[requestID] = struct{}{}
	} else {
		delete(o.approvals, requestID)
	}
	if existed == active {
		o.mu.Unlock()
		return
	}
	changed := o.host.applyCodexNativeWork(o.approvalWorkID(requestID), active)
	o.mu.Unlock()
	if changed {
		o.host.nudgeHarnessActivityReport()
	}
}

func (h *SessionHost) interruptCodexNativeTurn() bool {
	observer, client, turnID := h.codexNativeTurnForInterrupt()
	if observer == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(h.lifecycleContext(), observer.config.requestTimeout)
	defer cancel()
	if err := client.interruptTurn(ctx, observer.threadID, turnID); err != nil {
		h.reportLifecycle("warn", "Codex native turn interrupt failed", map[string]interface{}{"error": redactAgentDiagnosticText(err.Error())})
		return false
	}
	return true
}

func (h *SessionHost) scheduleCodexNativeInterrupt() bool {
	h.codexNativeMu.Lock()
	observer := h.codexNativeObserver
	h.codexNativeMu.Unlock()
	if observer == nil {
		return false
	}
	return observer.scheduleInterrupt()
}

func (o *codexNativeObserver) scheduleInterrupt() bool {
	o.host.codexNativeMu.Lock()
	current := o.host.codexNativeObserver == o
	o.host.codexNativeMu.Unlock()
	if !current {
		return false
	}
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return false
	}
	var turnID string
	for id := range o.activeTurns {
		turnID = id
		break
	}
	if turnID == "" {
		o.mu.Unlock()
		return false
	}
	if o.reconnecting || o.client == nil {
		o.pendingInterrupt = true
		o.mu.Unlock()
		return true
	}
	client := o.client
	o.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(o.host.lifecycleContext(), o.config.requestTimeout)
		defer cancel()
		if err := client.interruptTurn(ctx, o.threadID, turnID); err != nil {
			o.mu.Lock()
			if !o.closed {
				o.pendingInterrupt = true
			}
			o.mu.Unlock()
			o.host.reportLifecycle("warn", "Codex native turn interrupt failed", map[string]interface{}{"error": redactAgentDiagnosticText(err.Error())})
			_ = client.Close()
		}
	}()
	return true
}

func (h *SessionHost) codexNativeTurnForInterrupt() (*codexNativeObserver, codexNativeRPC, string) {
	h.codexNativeMu.Lock()
	observer := h.codexNativeObserver
	h.codexNativeMu.Unlock()
	if observer == nil {
		return nil, nil, ""
	}
	observer.mu.Lock()
	if observer.closed || observer.reconnecting {
		observer.mu.Unlock()
		return nil, nil, ""
	}
	var turnID string
	for id := range observer.activeTurns {
		turnID = id
		break
	}
	client := observer.client
	observer.mu.Unlock()
	if turnID == "" || client == nil {
		return nil, nil, ""
	}
	return observer, client, turnID
}

func (o *codexNativeObserver) monitorClient(ctx context.Context, client codexNativeRPC) {
	select {
	case <-ctx.Done():
		return
	case <-client.Done():
	}
	o.mu.Lock()
	if o.closed || o.client != client {
		o.mu.Unlock()
		return
	}
	o.reconnecting = true
	o.mu.Unlock()
	o.reconnect(ctx, client.Err())
}

func (o *codexNativeObserver) reconnect(ctx context.Context, cause error) {
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return
	}
	changed := o.host.applyCodexNativeWork(o.connectionWorkID(), true)
	o.mu.Unlock()
	if changed {
		o.host.nudgeHarnessActivityReport()
	}
	defer func() {
		if o.host.applyCodexNativeWork(o.connectionWorkID(), false) {
			o.host.nudgeHarnessActivityReport()
		}
	}()
	reconnectCtx, cancel := context.WithTimeout(ctx, o.config.reconnectTimeout)
	defer cancel()
	lastErr := cause
	connect := o.connect
	if connect == nil {
		connect = defaultCodexNativeConnect
	}
	for reconnectCtx.Err() == nil {
		o.mu.Lock()
		closed := o.closed
		o.mu.Unlock()
		if closed {
			return
		}
		client, err := connect(reconnectCtx, o.config, o.handleEnvelope)
		if err == nil {
			err = client.initialize(reconnectCtx)
		}
		if err == nil {
			err = client.resumeThread(reconnectCtx, o.threadID)
		}
		var thread json.RawMessage
		if err == nil {
			thread, err = client.readThread(reconnectCtx, o.threadID)
		}
		if err == nil {
			o.mu.Lock()
			if o.closed {
				o.mu.Unlock()
				_ = client.Close()
				return
			}
			o.client = client
			o.clearApprovalsLocked()
			o.mu.Unlock()
			if err = o.reconcileGuarded(thread); err == nil {
				o.mu.Lock()
				if o.closed || o.client != client {
					o.mu.Unlock()
					_ = client.Close()
					return
				}
				o.reconnecting = false
				pendingInterrupt := o.pendingInterrupt
				o.pendingInterrupt = false
				o.mu.Unlock()
				o.host.applyCodexNativeWork(o.connectionWorkID(), false)
				o.host.nudgeHarnessActivityReport()
				o.host.reportLifecycle("info", "Codex shared-daemon observer reconnected", map[string]interface{}{"threadId": o.threadID})
				go o.monitorClient(ctx, client)
				if pendingInterrupt {
					o.scheduleInterrupt()
				}
				return
			}
		}
		lastErr = err
		if client != nil {
			_ = client.Close()
		}
		timer := time.NewTimer(o.config.reconnectDelay)
		select {
		case <-reconnectCtx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	o.mu.Lock()
	closed := o.closed
	o.mu.Unlock()
	if closed {
		return
	}
	o.host.reportLifecycle("error", "Codex shared-daemon observer recovery failed", map[string]interface{}{
		"error": redactAgentDiagnosticText(fmt.Sprint(lastErr)),
	})
	o.close()
}

func (o *codexNativeObserver) connectionWorkID() string {
	return fmt.Sprintf("%s%p", codexNativeConnectionWorkPrefix, o)
}

func (o *codexNativeObserver) turnWorkID(turnID string) string {
	return fmt.Sprintf("turn:%p:%s", o, turnID)
}

func (o *codexNativeObserver) approvalWorkID(requestID string) string {
	return fmt.Sprintf("approval:%p:%s", o, requestID)
}

func (o *codexNativeObserver) clearApprovalsLocked() {
	for id := range o.approvals {
		o.host.applyCodexNativeWork(o.approvalWorkID(id), false)
	}
	o.approvals = make(map[string]struct{})
}
