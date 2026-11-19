package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// Live steering adds input to the agent's running prompt turn through the ACP
// extension `_session/steering` (Claude ACP, Codex ACP and SAM's OpenCode
// build). A steer never creates a prompt epoch: it attaches to the in-flight
// attempt and leaves its timeouts, idleness and terminal arbiter untouched.

const (
	steeringMethod = "_session/steering"

	// DefaultSteerTimeout bounds one `_session/steering` request. The adapters
	// answer as soon as input is queued into the turn, so this only trips when
	// the agent process is wedged.
	DefaultSteerTimeout = 20 * time.Second
)

// SteerOutcome is the VM's verdict on one steer. Only SteerInjected and
// SteerUnknown may have consumed the input; every other outcome guarantees the
// adapter never saw it, so the control plane may deliver it as a normal prompt.
type SteerOutcome string

const (
	// SteerInjected: the adapter accepted the input into the running turn.
	// This is not proof the model read or acted on it.
	SteerInjected SteerOutcome = "injected"
	// SteerPromptRequired: no turn was running; the input was not consumed.
	SteerPromptRequired SteerOutcome = "prompt_required"
	// SteerUnsupported: the loaded adapter cannot steer without risking a
	// detached turn; the input was not sent.
	SteerUnsupported SteerOutcome = "unsupported"
	// SteerRejected: the adapter refused the request before consuming it.
	SteerRejected SteerOutcome = "rejected"
	// SteerUnknown: the request may or may not have been consumed (transport
	// loss, timeout, adapter-internal failure, or a detached turn).
	SteerUnknown SteerOutcome = "unknown"
	// SteerNotClaimed: the durable invocation claim failed; nothing was sent.
	SteerNotClaimed SteerOutcome = "not_claimed"
)

// SteerResult reports the outcome and the prompt epoch the input attached to.
type SteerResult struct {
	Outcome SteerOutcome
	Reason  string
	// PromptEpoch is the attached attempt's start (Unix ms), or 0.
	PromptEpoch int64
	PromptID    uint64
}

// Consumed reports whether the adapter may have taken the input.
func (r SteerResult) Consumed() bool {
	return r.Outcome == SteerInjected || r.Outcome == SteerUnknown
}

// steeringSupport is what the loaded adapter proved at ACP initialize.
type steeringSupport struct {
	// Known is set once the adapter's ACP initialize has been read.
	Known bool
	// Advertised is InitializeResponse._meta.steering.supported.
	Advertised bool
	// PromptRequired means the adapter returns idle input unconsumed when the
	// request carries idleBehavior=promptRequired. Without it a steer racing
	// turn end starts a turn SAM does not own, so SAM never sends one.
	PromptRequired bool
	Adapter        string
	Version        string
}

// promptRequiredAdapters lists adapter builds verified to honor
// idleBehavior=promptRequired without advertising it. Claude ACP has done so
// since 0.81.2; codex-acp added it in 2.4.0 and SAM backported it to
// 2.1.1-sam-c2.3 (scripts/diagnostics/patches/codex-acp-v2.1.1-sam-c2.3.patch).
// Adapters that advertise `idleBehaviors` (SAM's OpenCode build) need no entry.
var promptRequiredAdapters = map[string]func(version string) bool{
	"@agentclientprotocol/claude-agent-acp": func(v string) bool { return semverAtLeast(v, 0, 81, 2) },
	"@agentclientprotocol/codex-acp": func(v string) bool {
		return v == "2.1.1-sam-c2.3" || semverAtLeast(v, 2, 4, 0)
	},
}

// Supported reports whether SAM will send steers to this adapter.
func (s steeringSupport) Supported() bool {
	return s.Advertised && s.PromptRequired
}

func steeringSupportFromInitialize(resp acpsdk.InitializeResponse) steeringSupport {
	support := steeringSupport{Known: true}
	if resp.AgentInfo != nil {
		support.Adapter = resp.AgentInfo.Name
		support.Version = resp.AgentInfo.Version
	}
	steering, _ := resp.Meta["steering"].(map[string]any)
	if supported, _ := steering["supported"].(bool); !supported {
		return support
	}
	support.Advertised = true
	if behaviors, ok := steering["idleBehaviors"].([]any); ok {
		for _, behavior := range behaviors {
			if behavior == "promptRequired" {
				support.PromptRequired = true
			}
		}
	}
	if known := promptRequiredAdapters[support.Adapter]; known != nil && known(support.Version) {
		support.PromptRequired = true
	}
	return support
}

// semverAtLeast compares a plain MAJOR.MINOR.PATCH release. Pre-release or
// build-suffixed versions never match: they need an explicit allowlist entry.
func semverAtLeast(version string, major, minor, patch int) bool {
	parts := strings.Split(version, ".")
	if len(parts) != 3 {
		return false
	}
	want := []int{major, minor, patch}
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return false
		}
		if n != want[i] {
			return n > want[i]
		}
	}
	return true
}

// SteeringSupported reports whether this host's loaded adapter can steer.
func (h *SessionHost) SteeringSupported() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.steering.Supported()
}

func (h *SessionHost) steerTimeout() time.Duration {
	if h.config.SteerTimeout > 0 {
		return h.config.SteerTimeout
	}
	return DefaultSteerTimeout
}

type steerTarget struct {
	conn      *acpsdk.ClientSideConnection
	sessionID acpsdk.SessionId
	attempt   *promptAttempt
}

// admitSteer binds a steer to the in-flight prompt attempt, or explains why
// none is steerable. It holds no lock on return.
//
// h.mu is held (read) across the nested promptMu section, in the same order as
// PrepareEviction, CheckpointRollover and beginGuardedCancel, so a checkpoint
// rollover or guarded cancel cannot begin between reading the connection and
// reading the prompt-admission flags. promptCancelMu is a leaf lock.
func (h *SessionHost) admitSteer() (steerTarget, SteerResult, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	conn, sessionID, status := h.acpConn, h.sessionID, h.status
	support, rollover := h.steering, h.checkpointRollover
	if !support.Advertised {
		return steerTarget{}, SteerResult{Outcome: SteerUnsupported, Reason: "adapter_does_not_advertise_steering"}, false
	}
	if !support.PromptRequired {
		return steerTarget{}, SteerResult{Outcome: SteerUnsupported, Reason: "adapter_idle_behavior_unverified"}, false
	}
	h.promptMu.Lock()
	attempt := h.promptAttempt
	inFlight := h.promptInFlight && attempt != nil && !attempt.isTerminal()
	fenced := h.evictionPending || h.guardedCancelPending
	h.promptMu.Unlock()
	// A rollover or stop in progress is reported before "no running turn": the turn it is
	// ending may already have returned, and the stop is the more precise reason.
	if rollover != nil {
		return steerTarget{}, SteerResult{Outcome: SteerPromptRequired, Reason: "checkpoint_in_progress"}, false
	}
	if fenced {
		return steerTarget{}, SteerResult{Outcome: SteerPromptRequired, Reason: "turn_stopping"}, false
	}
	if conn == nil || sessionID == "" || status != HostPrompting || !inFlight {
		return steerTarget{}, SteerResult{Outcome: SteerPromptRequired, Reason: "no_running_turn"}, false
	}
	if h.isPromptCancelRequested(attempt.id) {
		return steerTarget{}, SteerResult{Outcome: SteerPromptRequired, Reason: "turn_cancelling"}, false
	}
	return steerTarget{conn: conn, sessionID: sessionID, attempt: attempt}, SteerResult{}, true
}

// Steer adds text to the running turn. Steers for one host are admitted and
// sent one at a time, in arrival order. claim runs after admission and
// immediately before the adapter request (the durable possible-send boundary)
// with the epoch of the turn the steer attaches to; if it fails nothing is
// sent. The ordinary prompt gate is never taken, so a steer cannot block,
// start or end a prompt.
func (h *SessionHost) Steer(text, messageID string, claim func(promptEpoch int64) error) SteerResult {
	h.steerMu.Lock()
	defer h.steerMu.Unlock()

	target, refusal, ok := h.admitSteer()
	if !ok {
		return refusal
	}
	result := SteerResult{PromptEpoch: target.attempt.startedAt.UnixMilli(), PromptID: target.attempt.id}
	if claim != nil {
		if err := claim(result.PromptEpoch); err != nil {
			result.Outcome, result.Reason = SteerNotClaimed, err.Error()
			return result
		}
	}

	block := acpsdk.ContentBlock{Text: &acpsdk.ContentBlockText{Type: "text", Text: text}}
	// Bounded by the host lifecycle, never by the HTTP request: a disconnected
	// caller must not cancel an adapter request that may already have landed.
	ctx, cancel := context.WithTimeout(h.lifecycleContext(), h.steerTimeout())
	raw, err := target.conn.CallExtension(ctx, steeringMethod, map[string]any{
		"sessionId": target.sessionID,
		"prompt":    []acpsdk.ContentBlock{block},
		"_meta":     map[string]any{"steering": map[string]any{"idleBehavior": "promptRequired"}},
	})
	cancel()
	result.Outcome, result.Reason = classifySteerResponse(raw, err)

	fields := target.attempt.logFields(map[string]interface{}{
		"promptId": target.attempt.id,
		"outcome":  string(result.Outcome),
		"reason":   result.Reason,
	})
	switch result.Outcome {
	case SteerInjected:
		slog.Info("ACP steer injected into running turn", "promptId", target.attempt.id)
		h.reportLifecycle("info", "ACP steer injected", fields)
		// Adapters do not echo steered input. Mirror it under the control
		// plane's transcript message ID, which persistence de-duplicates.
		h.injectUserMessageNotifications(target.sessionID, []acpsdk.ContentBlock{block}, messageID)
	case SteerUnknown:
		slog.Warn("ACP steer outcome unknown", "promptId", target.attempt.id, "reason", result.Reason)
		h.reportLifecycle("warn", "ACP steer outcome unknown", fields)
	default:
		h.reportLifecycle("info", "ACP steer not consumed", fields)
	}
	return result
}

func classifySteerResponse(raw json.RawMessage, err error) (SteerOutcome, string) {
	if err != nil {
		var reqErr *acpsdk.RequestError
		if errors.As(err, &reqErr) {
			switch reqErr.Code {
			// The adapter refused the request itself; it never queued input.
			case -32600, -32601, -32602:
				return SteerRejected, fmt.Sprintf("adapter_rejected_%d", reqErr.Code)
			}
			return SteerUnknown, fmt.Sprintf("adapter_error_%d", reqErr.Code)
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return SteerUnknown, "steer_timeout"
		}
		// The host lifecycle ended (Stop) while the request was outstanding.
		if errors.Is(err, context.Canceled) {
			return SteerUnknown, "host_stopped"
		}
		return SteerUnknown, "transport_error"
	}
	var resp struct {
		Outcome string `json:"outcome"`
		Reason  string `json:"reason"`
	}
	if json.Unmarshal(raw, &resp) != nil {
		return SteerUnknown, "invalid_adapter_response"
	}
	switch resp.Outcome {
	case "injected":
		return SteerInjected, ""
	case "promptRequired":
		return SteerPromptRequired, "no_running_turn"
	case "startedNewTurn":
		// Only possible if an adapter ignored promptRequired: the input started
		// a turn SAM does not own. Never replay it.
		return SteerUnknown, "adapter_started_detached_turn"
	default:
		return SteerUnknown, "adapter_outcome_" + resp.Outcome
	}
}
