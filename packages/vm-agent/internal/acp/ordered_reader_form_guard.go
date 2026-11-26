package acp

import "encoding/json"

// The pinned SDK decodes requestedSchema into a generated struct and discards
// unknown root and nested property members. Preserve the fail-closed schema contract at the raw
// JSON-RPC boundary by turning unsupported forms into a schema the host will
// explicitly cancel. Validate the original schema before typed SDK decoding
// can erase a constraint; runtime-specific size limits are checked by the host.
func guardRawElicitationSchema(line []byte, expectedSession string) []byte {
	var envelope map[string]json.RawMessage
	if json.Unmarshal(line, &envelope) != nil {
		return line
	}
	var params map[string]json.RawMessage
	if json.Unmarshal(envelope["params"], &params) != nil {
		return line
	}
	var mode string
	if json.Unmarshal(params["mode"], &mode) != nil || (mode != "form" && mode != "url") {
		return line
	}
	if mode == "url" {
		allowed := map[string]bool{"mode": true, "message": true, "url": true,
			"elicitationId": true, "sessionId": true, "toolCallId": true,
			"requestId": true, "_meta": true}
		unsupported := false
		if expectedSession != "" {
			var claimed string
			if json.Unmarshal(params["sessionId"], &claimed) != nil || claimed != expectedSession {
				unsupported = true
			}
		}
		for key := range params {
			if !allowed[key] {
				unsupported = true
			}
		}
		if !unsupported {
			return line
		}
		params["url"] = json.RawMessage(`""`)
		encodedParams, err := json.Marshal(params)
		if err != nil {
			return line
		}
		envelope["params"] = encodedParams
		guarded, err := json.Marshal(envelope)
		if err != nil {
			return line
		}
		return guarded
	}
	var schema map[string]json.RawMessage
	if json.Unmarshal(params["requestedSchema"], &schema) != nil {
		return line
	}
	allowedSchema := map[string]bool{"type": true, "title": true, "description": true, "properties": true, "required": true}
	allowedParams := map[string]bool{"mode": true, "message": true, "requestedSchema": true,
		"sessionId": true, "toolCallId": true, "requestId": true, "_meta": true}
	unsupported := false
	if expectedSession != "" {
		var claimedSession string
		if json.Unmarshal(params["sessionId"], &claimedSession) != nil || claimedSession != expectedSession {
			unsupported = true
		}
	}
	for key := range schema {
		if !allowedSchema[key] {
			unsupported = true
		}
	}
	for key := range params {
		if !allowedParams[key] {
			unsupported = true
		}
	}
	// Structural validation uses a ceiling derived from the already-bounded
	// frame, so it cannot impose tighter size limits than the host's config.
	// The callback still enforces the real per-session limits afterwards.
	var original map[string]any
	frameBound := len(line)
	limits := acpFormLimits{properties: frameBound,
		enum: frameBound, answerBytes: frameBound, stringBytes: frameBound,
		keyChars: frameBound, labelChars: frameBound}
	if json.Unmarshal(params["requestedSchema"], &original) != nil {
		unsupported = true
	} else {
		// JSON re-encoding escapes HTML and Unicode separators. Measure the
		// normalized bytes instead of imposing the raw frame's smaller byte size.
		normalized, err := json.Marshal(original)
		limits.schemaBytes = len(normalized)
		if err != nil || !validateAcpFormSchema(original, limits) {
			unsupported = true
		}
	}
	if !unsupported {
		return line
	}
	params["requestedSchema"] = json.RawMessage(`{"type":"object","properties":{"__unsupported_schema__":{"type":"unsupported"}}}`)
	encodedParams, err := json.Marshal(params)
	if err != nil {
		return line
	}
	envelope["params"] = encodedParams
	guarded, err := json.Marshal(envelope)
	if err != nil {
		return line
	}
	return guarded
}
