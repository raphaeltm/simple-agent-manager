package acp

import "encoding/json"

// The pinned SDK decodes requestedSchema into a generated struct and discards
// unknown root members. Preserve the fail-closed schema contract at the raw
// JSON-RPC boundary by turning unsupported forms into a schema the host will
// explicitly cancel. Field-level constraints survive SDK decode and are
// checked by validateAcpFormSchema in the callback.
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
	if json.Unmarshal(params["mode"], &mode) != nil || mode != "form" {
		return line
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
