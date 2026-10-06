package acp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"
)

// URL navigation is performed by the browser after an explicit creator gesture.
// SAM does not fetch this URL or follow redirects. Explicit local callbacks are
// rejected because a remote browser cannot complete the wrapper's loopback flow.
func eligibleAcpURL(raw string, maxChars, maxDepth int) bool {
	return classifyAcpURLDepth(raw, 0, maxChars, maxDepth) == acpURLEligible
}

type acpURLStatus uint8

const (
	acpURLInvalid acpURLStatus = iota
	acpURLEligible
	acpURLLoopbackOnly
)

// The loopback status means every other URL constraint passed. It is used only
// to select fixed guidance; the URL itself is never exposed in a transcript.
func classifyAcpURLDepth(raw string, depth, maxChars, maxDepth int) acpURLStatus {
	if depth > maxDepth {
		return acpURLInvalid
	}
	if len(raw) == 0 || utf8.RuneCountInString(raw) > maxChars || strings.TrimSpace(raw) != raw || strings.ContainsAny(raw, "\\;") {
		return acpURLInvalid
	}
	for _, char := range []byte(raw) {
		if char < 0x20 || char == 0x7f {
			return acpURLInvalid
		}
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil || parsed.Fragment != "" || parsed.Hostname() == "" {
		return acpURLInvalid
	}
	host := strings.ToLower(parsed.Hostname())
	loopback := explicitAcpLoopbackHost(host)
	if loopback && strings.HasSuffix(parsed.Host, ":") {
		return acpURLInvalid
	}
	if loopback && parsed.Port() != "" {
		port, err := strconv.Atoi(parsed.Port())
		if err != nil || port < 1 || port > 65535 {
			return acpURLInvalid
		}
	}
	if !strings.EqualFold(parsed.Scheme, "https") && !(loopback && strings.EqualFold(parsed.Scheme, "http")) {
		return acpURLInvalid
	}
	if parsed.Port() != "" && parsed.Port() != "443" && !loopback {
		return acpURLInvalid
	}
	status := acpURLEligible
	if loopback {
		status = acpURLLoopbackOnly
	}
	if !loopback && (net.ParseIP(host) != nil || !strings.Contains(host, ".") || strings.Contains(host, "..") ||
		strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".internal")) {
		return acpURLInvalid
	}
	parts := strings.Split(host, ".")
	if !loopback {
		for _, part := range parts {
			if part == "" || strings.HasPrefix(part, "xn--") || strings.HasPrefix(part, "-") || strings.HasSuffix(part, "-") {
				return acpURLInvalid
			}
			for _, char := range part {
				if !((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-') {
					return acpURLInvalid
				}
			}
		}
		if len(parts[len(parts)-1]) < 2 {
			return acpURLInvalid
		}
		for _, char := range parts[len(parts)-1] {
			if char < 'a' || char > 'z' {
				return acpURLInvalid
			}
		}
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return acpURLInvalid
	}
	for key, values := range query {
		switch strings.ToLower(key) {
		case "redirect", "redirect_uri", "redirect_url", "callback", "callback_uri", "callback_url", "return_to", "return_url", "return_uri", "next", "continue":
			for _, value := range values {
				nested := classifyAcpURLDepth(value, depth+1, maxChars, maxDepth)
				if nested == acpURLInvalid {
					return acpURLInvalid
				}
				if nested == acpURLLoopbackOnly {
					status = acpURLLoopbackOnly
				}
			}
		}
	}
	return status
}

func explicitAcpLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	if strings.HasSuffix(host, ".localhost") {
		for _, part := range strings.Split(strings.TrimSuffix(host, ".localhost"), ".") {
			if part == "" || strings.HasPrefix(part, "xn--") || strings.HasPrefix(part, "-") || strings.HasSuffix(part, "-") {
				return false
			}
			for _, char := range part {
				if !((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-') {
					return false
				}
			}
		}
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || (ip.To4() != nil && ip.To4()[0] == 127))
}

func (h *SessionHost) registerURLWaiter(id, elicitationID, generation string, attemptID uint64,
	deadline time.Time, cancel context.CancelFunc) (*acpInteractionWaiter, bool) {
	h.promptMu.Lock()
	defer h.promptMu.Unlock()
	h.interactionMu.Lock()
	defer h.interactionMu.Unlock()
	if !h.interactionConfig.Enabled || !h.interactionConfig.URLsEnabled ||
		generation == "" || generation != h.interactionGeneration ||
		!h.promptInFlight || h.promptAttempt == nil || h.promptAttempt.id != attemptID ||
		h.promptAttempt.ctx.Err() != nil || len(h.urlElicitations) >= h.interactionConfig.ReceiptLimit {
		return nil, false
	}
	if _, exists := h.urlElicitations[elicitationID]; exists {
		return nil, false
	}
	waiter := &acpInteractionWaiter{generation: generation, attemptID: attemptID,
		urlRequest: true, result: make(chan acpInteractionWaitResult, 1), cancelRequest: cancel}
	h.interactionWaiters[id] = waiter
	h.urlElicitations[elicitationID] = acpUrlElicitation{interactionID: id, generation: generation, deadline: deadline}
	// Keep a bounded tombstone for this entire connection generation. A delayed
	// duplicate completion must never bind to a new request reusing the same ID.
	// ReceiptLimit caps memory; a generation restart clears all tombstones.
	return waiter, true
}

func (h *SessionHost) requestURL(ctx context.Context, generation string,
	params acpsdk.UnstableCreateElicitationRequest) (acpsdk.UnstableCreateElicitationResponse, error) {
	config := h.acpInteractionConfigSnapshot()
	if params.Url == nil || params.Form != nil || len(params.Url.Meta) != 0 ||
		!config.Enabled || !config.URLsEnabled || config.validate() != nil ||
		h.config.ProjectID == "" || h.config.WorkspaceID == "" || h.config.SessionID == "" ||
		h.config.RuntimeIdentity == "" || h.callbackToken() == "" || h.config.ControlPlaneURL == "" ||
		len(params.Url.ElicitationId) == 0 || len(utf16.Encode([]rune(params.Url.ElicitationId))) > config.URLElicitationIDMaxChars ||
		len(params.Url.Message) > config.RequestMaxBytes {
		return acpsdk.NewUnstableCreateElicitationResponseCancel(), nil
	}
	// Bind diagnostics to the attempt that received this request. A subsequent
	// prompt in the same connection generation must not inherit its diagnosis.
	attempt, active := h.activePromptAttempt()
	if !active {
		return acpsdk.NewUnstableCreateElicitationResponseCancel(), nil
	}
	urlStatus := classifyAcpURLDepth(params.Url.Url, 0, config.URLMaxChars, config.URLRedirectDepth)
	if urlStatus != acpURLEligible {
		if urlStatus == acpURLLoopbackOnly && ctx.Err() == nil {
			message := params.Url.Message
			encoded, err := json.Marshal(acpInteractionDetail{
				Message: &message, URL: params.Url.Url, ElicitationID: string(params.Url.ElicitationId),
			})
			if err == nil && len(encoded) <= config.RequestMaxBytes {
				h.reportUnsupportedLoopbackAuth(ctx, generation, attempt.id)
			}
		}
		return acpsdk.NewUnstableCreateElicitationResponseCancel(), nil
	}
	urlConfig := config
	urlConfig.PermissionDeadlineMs = config.URLDeadlineMs
	deadline, ok := h.permissionDeadline(attempt.ctx, urlConfig)
	if !ok {
		return acpsdk.NewUnstableCreateElicitationResponseCancel(), nil
	}
	id := uuid.NewString()
	message := params.Url.Message
	detail := acpInteractionDetail{Message: &message, URL: params.Url.Url, ElicitationID: string(params.Url.ElicitationId)}
	encoded, err := json.Marshal(detail)
	if err != nil || len(encoded) > config.RequestMaxBytes {
		return acpsdk.NewUnstableCreateElicitationResponseCancel(), nil
	}
	request := acpInteractionCreateRequest{ProtocolVersion: acpInteractionProtocolVersion,
		InteractionID: id, Generation: generation, RuntimeIdentity: h.config.RuntimeIdentity,
		AgentSessionID: h.config.SessionID, Kind: "url", Detail: detail, DeadlineAt: deadline.UnixMilli()}
	canonical, err := json.Marshal(request)
	if err != nil {
		return acpsdk.NewUnstableCreateElicitationResponseCancel(), nil
	}
	digest := sha256.Sum256(canonical)
	request.PayloadHash = hex.EncodeToString(digest[:])
	requestCtx, cancel := context.WithDeadline(attempt.ctx, deadline)
	go func() {
		select {
		case <-attempt.done:
			cancel()
		case <-requestCtx.Done():
		}
	}()
	stopCancel := context.AfterFunc(ctx, cancel)
	defer stopCancel()
	defer cancel()
	waiter, ok := h.registerURLWaiter(id, string(params.Url.ElicitationId), generation, attempt.id, deadline, cancel)
	if !ok {
		return acpsdk.NewUnstableCreateElicitationResponseCancel(), nil
	}
	createDone := make(chan acpInteractionCreateResult, 1)
	go func() {
		outcome, err := h.createAcpInteraction(requestCtx, request)
		createDone <- acpInteractionCreateResult{outcome, err}
	}()
	var result acpInteractionWaitResult
	select {
	case result = <-waiter.result:
	case created := <-createDone:
		if created.outcome == acpInteractionCreateRejected {
			h.cancelAcpInteractionWaiter(id, generation, "wrapper_cancelled")
		}
		select {
		case result = <-waiter.result:
		case <-requestCtx.Done():
			reason := "wrapper_cancelled"
			if !h.now().Before(deadline) {
				reason = "expired"
			}
			h.cancelAcpInteractionWaiterForAttempt(id, generation, attempt.id, reason)
			result = <-waiter.result
		}
	case <-requestCtx.Done():
		reason := "wrapper_cancelled"
		if !h.now().Before(deadline) {
			reason = "expired"
		}
		h.cancelAcpInteractionWaiterForAttempt(id, generation, attempt.id, reason)
		result = <-waiter.result
	}
	if result.cancel {
		settleReason := result.reason
		if settleReason == "declined" {
			settleReason = "completed"
		}
		if settleReason == "" {
			settleReason = "wrapper_cancelled"
		}
		go h.settleAcpInteraction(acpInteractionSettleRequest{ProtocolVersion: acpInteractionProtocolVersion,
			InteractionID: id, Generation: generation, RuntimeIdentity: h.config.RuntimeIdentity,
			AgentSessionID: h.config.SessionID, Reason: settleReason}, deadline)
		h.interactionMu.Lock()
		if entry, exists := h.urlElicitations[string(params.Url.ElicitationId)]; exists && entry.interactionID == id {
			entry.cancelled = true
			h.urlElicitations[string(params.Url.ElicitationId)] = entry
		}
		h.interactionMu.Unlock()
		if result.reason == "declined" {
			return acpsdk.NewUnstableCreateElicitationResponseDecline(), nil
		}
		return acpsdk.NewUnstableCreateElicitationResponseCancel(), nil
	}
	return acpsdk.NewUnstableCreateElicitationResponseAccept(), nil
}

func (c *sessionHostClient) UnstableCompleteElicitation(_ context.Context,
	params acpsdk.UnstableCompleteElicitationNotification) error {
	if len(params.Meta) != 0 {
		return nil
	}
	h := c.host
	h.interactionMu.Lock()
	entry, exists := h.urlElicitations[string(params.ElicitationId)]
	if !exists || entry.generation != c.interactionGeneration || entry.generation != h.interactionGeneration ||
		entry.completed || entry.cancelled || !entry.deadline.After(h.now()) {
		h.interactionMu.Unlock()
		return nil
	}
	entry.completed = true
	h.urlElicitations[string(params.ElicitationId)] = entry
	h.interactionMu.Unlock()
	go h.completeURLInteraction(entry, string(params.ElicitationId))
	return nil
}

func (h *SessionHost) completeURLInteraction(entry acpUrlElicitation, elicitationID string) {
	ctx, cancel := context.WithDeadline(context.Background(), entry.deadline)
	defer cancel()
	body, err := json.Marshal(map[string]any{"protocolVersion": acpInteractionProtocolVersion,
		"interactionId": entry.interactionID, "generation": entry.generation,
		"runtimeIdentity": h.config.RuntimeIdentity, "agentSessionId": h.config.SessionID,
		"elicitationId": elicitationID})
	if err != nil {
		return
	}
	endpoint := strings.TrimRight(h.config.ControlPlaneURL, "/") + "/api/projects/" +
		url.PathEscape(h.config.ProjectID) + "/workspaces/" + url.PathEscape(h.config.WorkspaceID) +
		"/acp-interactions/" + url.PathEscape(entry.interactionID) + "/complete-url"
	config := h.acpInteractionConfigSnapshot()
	for attempt := 0; ctx.Err() == nil; attempt++ {
		if attempt > 0 {
			delay := config.SettleRetrySteadyMs
			if attempt-1 < len(config.SettleRetryDelaysMs) {
				delay = config.SettleRetryDelaysMs[attempt-1]
			}
			timer := time.NewTimer(time.Duration(delay) * time.Millisecond)
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				return
			}
		}
		h.interactionMu.Lock()
		active := h.interactionGeneration == entry.generation
		h.interactionMu.Unlock()
		if !active {
			return
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+h.callbackToken())
		req.Header.Set("Content-Type", "application/json")
		resp, err := h.httpClient().Do(req)
		if err != nil {
			continue
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, config.ResponseMaxBytes))
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return
		}
		if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusConflict || resp.StatusCode == http.StatusGone ||
			resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return
		}
	}
}
