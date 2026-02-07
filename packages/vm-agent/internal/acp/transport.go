package acp

import (
	"encoding/json"
)

// ControlMessageType identifies non-ACP control messages on the WebSocket.
type ControlMessageType string

const (
	// MsgSelectAgent is sent by the browser to request agent selection/switching.
	MsgSelectAgent ControlMessageType = "select_agent"
	// MsgAgentStatus is sent by the gateway to the browser with agent lifecycle updates.
	MsgAgentStatus ControlMessageType = "agent_status"
)

// AgentStatus represents the lifecycle state of an agent session.
type AgentStatus string

const (
	StatusStarting   AgentStatus = "starting"
	StatusReady      AgentStatus = "ready"
	StatusError      AgentStatus = "error"
	StatusRestarting AgentStatus = "restarting"
)

// SelectAgentMessage is sent by the browser to request agent selection.
type SelectAgentMessage struct {
	Type      ControlMessageType `json:"type"`
	AgentType string             `json:"agentType"`
}

// AgentStatusMessage is sent by the gateway to update the browser on agent status.
type AgentStatusMessage struct {
	Type      ControlMessageType `json:"type"`
	Status    AgentStatus        `json:"status"`
	AgentType string             `json:"agentType"`
	Error     string             `json:"error,omitempty"`
}

// WebSocketMessage is a raw message received from the WebSocket.
// It may be either a control message or an ACP JSON-RPC message.
type WebSocketMessage struct {
	// Type is present only for control messages. Empty for ACP messages.
	Type string `json:"type,omitempty"`
	// Raw holds the original JSON for forwarding.
	Raw json.RawMessage
}

// ParseWebSocketMessage determines if a raw WebSocket text message is a
// control message (has a "type" field matching known control types) or
// an ACP JSON-RPC message (has "jsonrpc" field).
func ParseWebSocketMessage(data []byte) (isControl bool, controlType ControlMessageType) {
	var probe struct {
		Type    string `json:"type"`
		JSONRPC string `json:"jsonrpc"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return false, ""
	}

	switch ControlMessageType(probe.Type) {
	case MsgSelectAgent:
		return true, MsgSelectAgent
	case MsgAgentStatus:
		return true, MsgAgentStatus
	default:
		// Not a control message — treat as ACP JSON-RPC
		return false, ""
	}
}
