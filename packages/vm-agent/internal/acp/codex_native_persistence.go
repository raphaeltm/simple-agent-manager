package acp

import (
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"
)

type codexNativeSeenState uint8

const (
	codexNativeSeenReserved codexNativeSeenState = iota + 1
	codexNativeSeenCommitted
)

func (o *codexNativeObserver) persistItem(item codexNativeItem, broadcastUser bool) {
	o.mu.Lock()
	closed := o.closed
	o.mu.Unlock()
	if closed || item.ID == "" {
		return
	}
	message := nativeMessageReport(o.threadID, item)
	if message == nil || !o.reserveItem(item.ID) {
		return
	}
	if o.host.config.MessageReporter != nil {
		if err := o.host.config.MessageReporter.Enqueue(*message); err != nil {
			o.releaseItem(item.ID)
			slog.Warn("Codex shared-daemon observer could not enqueue item", "itemId", item.ID, "error", err)
			return
		}
	}
	o.commitItem(item.ID)
	if broadcastUser && message.Role == "user" {
		o.mu.Lock()
		closed := o.closed
		o.mu.Unlock()
		if !closed {
			o.broadcastText(*message)
		}
	}
}

func (o *codexNativeObserver) reserveItem(itemID string) bool {
	key := o.threadID + ":" + itemID
	o.host.codexNativeMu.Lock()
	defer o.host.codexNativeMu.Unlock()
	if _, ok := o.host.codexNativeSeen[key]; ok {
		return false
	}
	if o.host.codexNativeSeen == nil {
		o.host.codexNativeSeen = make(map[string]codexNativeSeenState)
	}
	o.host.codexNativeSeen[key] = codexNativeSeenReserved
	return true
}

func (o *codexNativeObserver) releaseItem(itemID string) {
	key := o.threadID + ":" + itemID
	o.host.codexNativeMu.Lock()
	defer o.host.codexNativeMu.Unlock()
	if o.host.codexNativeSeen[key] == codexNativeSeenReserved {
		delete(o.host.codexNativeSeen, key)
	}
}

func (o *codexNativeObserver) commitItem(itemID string) {
	key := o.threadID + ":" + itemID
	o.host.codexNativeMu.Lock()
	defer o.host.codexNativeMu.Unlock()
	if o.host.codexNativeSeen[key] != codexNativeSeenReserved {
		return
	}
	o.host.codexNativeSeen[key] = codexNativeSeenCommitted
	o.host.codexNativeSeenOrder = append(o.host.codexNativeSeenOrder, key)
	if len(o.host.codexNativeSeenOrder) > o.config.dedupeLimit {
		delete(o.host.codexNativeSeen, o.host.codexNativeSeenOrder[0])
		o.host.codexNativeSeenOrder = o.host.codexNativeSeenOrder[1:]
	}
}

func (o *codexNativeObserver) broadcastText(message MessageReportEntry) {
	update := acpsdk.UpdateUserMessageText(message.Content)
	notification := acpsdk.SessionNotification{SessionId: acpsdk.SessionId(o.threadID), Update: update}
	data, err := json.Marshal(map[string]interface{}{"jsonrpc": "2.0", "method": "session/update", "params": notification})
	if err == nil {
		o.host.broadcastMessage(data)
	}
}

func nativeMessageReport(threadID string, item codexNativeItem) *MessageReportEntry {
	messageID := uuid.NewSHA1(uuid.NameSpaceURL, []byte("sam:codex:"+threadID+":"+item.ID)).String()
	entry := &MessageReportEntry{MessageID: messageID, Timestamp: time.Now().UTC().Format(time.RFC3339Nano)}
	switch item.Type {
	case "userMessage":
		entry.Role, entry.Content = "user", nativeUserText(item.Content)
	case "agentMessage":
		entry.Role, entry.Content = "assistant", item.Text
	case "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch":
		name := item.Tool
		if item.Server != "" {
			name = item.Server + "/" + item.Tool
		}
		if name == "" {
			name = item.Type
		}
		metadata, _ := json.Marshal(ToolMeta{ToolCallId: item.ID, Title: name, ToolName: name, Status: nativeToolStatus(item.Status)})
		entry.Role, entry.ToolMetadata = "tool", string(metadata)
	default:
		return nil
	}
	if entry.Content == "" && entry.ToolMetadata == "" {
		return nil
	}
	return entry
}

func nativeUserText(raw json.RawMessage) string {
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if block.Type == "text" && block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func nativeToolStatus(status string) string {
	switch status {
	case "completed":
		return "completed"
	case "failed", "declined":
		return "failed"
	default:
		return "in_progress"
	}
}
