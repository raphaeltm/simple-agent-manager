package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// HandlePrompt routes a session/prompt request through the ACP SDK.
// Only one prompt runs at a time — concurrent requests are serialized.
func (h *SessionHost) HandlePrompt(ctx context.Context, reqID json.RawMessage, params json.RawMessage, viewerID string) {
	promptReq, ok := h.preparePromptRequest(params, viewerID, reqID)
	if !ok {
		return
	}
	h.persistLastPrompt(promptReq.firstTextContent)
	h.injectUserMessageNotifications(promptReq.sessionID, promptReq.blocks)
	h.cancelAutoSuspendTimer()

	promptCtx, promptCancel, promptTimeout := h.newPromptContext(ctx)
	promptID, ok := h.beginPrompt(promptCancel)
	if !ok {
		promptCancel()
		h.sendJSONRPCErrorToViewer(viewerID, reqID, -32603, "Prompt already in progress")
		return
	}
	defer func() {
		h.endPrompt(promptID)
		promptCancel()
	}()

	promptDone := h.startPromptWatchdog(promptID, promptCtx, viewerID, reqID, promptTimeout)
	defer close(promptDone)

	promptStart := time.Now()
	h.markPromptStarted(promptReq.sessionID, len(promptReq.blocks), viewerID)
	resp, err := promptReq.acpConn.Prompt(promptCtx, acpsdk.PromptRequest{
		SessionId: promptReq.sessionID,
		Prompt:    promptReq.blocks,
	})

	if !h.isPromptActive(promptID) {
		return
	}
	cancelRequested := h.isPromptCancelRequested(promptID)
	h.markPromptDone()
	h.finishPrompt(promptCtx, reqID, promptStartInfo{
		startedAt: promptStart,
		timeout:   promptTimeout,
		viewerID:  viewerID,
	}, resp, err, cancelRequested)
}

type preparedPromptRequest struct {
	acpConn          *acpsdk.ClientSideConnection
	sessionID        acpsdk.SessionId
	blocks           []acpsdk.ContentBlock
	firstTextContent string
}

type promptStartInfo struct {
	startedAt time.Time
	timeout   time.Duration
	viewerID  string
}

func (h *SessionHost) preparePromptRequest(params json.RawMessage, viewerID string, reqID json.RawMessage) (preparedPromptRequest, bool) {
	acpConn, sessionID := h.currentACPSession()
	if acpConn == nil || sessionID == acpsdk.SessionId("") {
		slog.Warn("Prompt request received but no ACP session active")
		h.reportLifecycle("warn", "Prompt received but no ACP session active", nil)
		h.sendJSONRPCErrorToViewer(viewerID, reqID, -32603, "No ACP session active")
		return preparedPromptRequest{}, false
	}

	blocks, firstTextContent, err := parsePromptBlocks(params)
	if err != nil {
		slog.Error("Failed to parse prompt params", "error", err)
		h.sendJSONRPCErrorToViewer(viewerID, reqID, -32602, "Invalid prompt params")
		return preparedPromptRequest{}, false
	}
	if len(blocks) == 0 {
		h.sendJSONRPCErrorToViewer(viewerID, reqID, -32602, "Empty prompt")
		return preparedPromptRequest{}, false
	}
	return preparedPromptRequest{acpConn: acpConn, sessionID: sessionID, blocks: blocks, firstTextContent: firstTextContent}, true
}

func (h *SessionHost) currentACPSession() (*acpsdk.ClientSideConnection, acpsdk.SessionId) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.acpConn, h.sessionID
}

func parsePromptBlocks(params json.RawMessage) ([]acpsdk.ContentBlock, string, error) {
	var promptParams struct {
		Prompt []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"prompt"`
	}
	if err := json.Unmarshal(params, &promptParams); err != nil {
		return nil, "", err
	}

	var blocks []acpsdk.ContentBlock
	var firstTextContent string
	for _, p := range promptParams.Prompt {
		if p.Type != "text" || p.Text == "" {
			continue
		}
		blocks = append(blocks, acpsdk.TextBlock(p.Text))
		if firstTextContent == "" {
			firstTextContent = p.Text
		}
	}
	return blocks, firstTextContent, nil
}

func (h *SessionHost) injectUserMessageNotifications(sessionID acpsdk.SessionId, blocks []acpsdk.ContentBlock) {
	for _, block := range blocks {
		notif := acpsdk.SessionNotification{
			SessionId: sessionID,
			Update:    acpsdk.UpdateUserMessage(block),
		}
		data, marshalErr := json.Marshal(map[string]interface{}{
			"jsonrpc": "2.0",
			"method":  "session/update",
			"params":  notif,
		})
		if marshalErr != nil {
			slog.Error("Failed to marshal synthetic user_message_chunk", "error", marshalErr)
			continue
		}
		h.broadcastMessage(data)

		// Enqueue to message reporter for Durable Object persistence.
		if h.config.MessageReporter != nil {
			for _, m := range ExtractMessages(notif) {
				if err := h.config.MessageReporter.Enqueue(MessageReportEntry{
					MessageID:    m.MessageID,
					Role:         m.Role,
					Content:      m.Content,
					ToolMetadata: m.ToolMetadata,
				}); err != nil {
					slog.Warn("messagereport: enqueue synthetic user message failed (non-blocking)",
						"messageId", m.MessageID, "error", err)
				}
			}
		}
	}
}

func (h *SessionHost) cancelAutoSuspendTimer() {
	h.viewerMu.Lock()
	if h.suspendTimer != nil {
		h.suspendTimer.Stop()
		h.suspendTimer = nil
		slog.Info("SessionHost: auto-suspend timer cancelled (prompt started)", "sessionID", h.config.SessionID)
	}
	h.viewerMu.Unlock()
}

func (h *SessionHost) newPromptContext(ctx context.Context) (context.Context, context.CancelFunc, time.Duration) {
	promptTimeout := h.promptTimeout()
	if promptTimeout > 0 {
		promptCtx, promptCancel := context.WithTimeout(ctx, promptTimeout)
		return promptCtx, promptCancel, promptTimeout
	}
	promptCtx, promptCancel := context.WithCancel(ctx)
	return promptCtx, promptCancel, promptTimeout
}

func (h *SessionHost) startPromptWatchdog(
	promptID uint64,
	promptCtx context.Context,
	viewerID string,
	reqID json.RawMessage,
	promptTimeout time.Duration,
) chan struct{} {
	promptDone := make(chan struct{})
	if promptTimeout > 0 {
		go h.watchPromptTimeout(promptID, promptCtx, promptDone, viewerID, reqID, promptTimeout)
	}
	return promptDone
}

func (h *SessionHost) markPromptStarted(sessionID acpsdk.SessionId, blockCount int, viewerID string) {
	h.setStatus(HostPrompting, "")
	h.broadcastControl(MsgSessionPrompting, nil)

	slog.Info("ACP: sending Prompt", "sessionID", string(sessionID), "blockCount", blockCount)
	h.reportLifecycle("info", "ACP Prompt started", map[string]interface{}{
		"acpSessionId": string(sessionID),
		"blockCount":   blockCount,
		"viewerId":     viewerID,
	})
}

func (h *SessionHost) markPromptDone() {
	h.setStatus(HostReady, "")
	h.broadcastControl(MsgSessionPromptDone, nil)
}

func (h *SessionHost) finishPrompt(
	promptCtx context.Context,
	reqID json.RawMessage,
	info promptStartInfo,
	resp acpsdk.PromptResponse,
	err error,
	cancelRequested bool,
) {
	if cancelRequested {
		h.finishPromptCancelled(reqID, info)
		return
	}
	if err != nil {
		h.finishPromptWithError(promptCtx, reqID, info, err)
		return
	}

	slog.Info("ACP: Prompt completed", "stopReason", string(resp.StopReason))
	h.reportLifecycle("info", "ACP Prompt completed", map[string]interface{}{
		"stopReason": string(resp.StopReason),
		"duration":   time.Since(info.startedAt).String(),
	})
	h.checkStderrForSilentErrors(resp.StopReason)
	h.broadcastPromptResponse(reqID, resp)
	h.notifyPromptComplete(string(resp.StopReason), nil)
}

func (h *SessionHost) finishPromptCancelled(reqID json.RawMessage, info promptStartInfo) {
	slog.Info("ACP: Prompt cancelled")
	h.reportLifecycle("info", "ACP Prompt cancelled", map[string]interface{}{
		"duration": time.Since(info.startedAt).String(),
	})
	h.broadcastMessage(h.marshalJSONRPCError(reqID, -32800, "Prompt cancelled"))
	h.notifyPromptComplete("cancelled", context.Canceled)
}

func (h *SessionHost) finishPromptWithError(promptCtx context.Context, reqID json.RawMessage, info promptStartInfo, err error) {
	errMsg := fmt.Sprintf("Prompt failed: %v", err)
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(promptCtx.Err(), context.DeadlineExceeded) {
		if info.timeout > 0 {
			errMsg = fmt.Sprintf("Prompt timed out after %s", info.timeout)
		} else {
			errMsg = "Prompt cancelled (context deadline exceeded)"
		}
	}
	slog.Warn("ACP Prompt failed (non-fatal)", "error", err)
	h.reportLifecycle("warn", "ACP Prompt failed", map[string]interface{}{
		"error":    errMsg,
		"duration": time.Since(info.startedAt).String(),
	})
	h.broadcastMessage(h.marshalJSONRPCError(reqID, -32603, errMsg))
	h.notifyPromptComplete("error", err)
}

func (h *SessionHost) broadcastPromptResponse(reqID json.RawMessage, resp acpsdk.PromptResponse) {
	result, _ := json.Marshal(resp)
	response := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(reqID),
		"result":  json.RawMessage(result),
	}
	data, _ := json.Marshal(response)
	h.broadcastMessage(data)
}

func (h *SessionHost) notifyPromptComplete(stopReason string, err error) {
	if cb := h.config.OnPromptComplete; cb != nil {
		go cb(stopReason, err)
	}
}
