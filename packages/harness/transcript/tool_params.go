package transcript

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"sort"
)

// ToolParamSummary is the transcript-safe representation of a single tool
// parameter value. It intentionally excludes the raw value while retaining
// enough deterministic metadata to debug parameter shape and equality.
type ToolParamSummary struct {
	Type       string `json:"type"`
	Redacted   bool   `json:"redacted"`
	ByteLength int    `json:"byte_length"`
	SHA256     string `json:"sha256"`
}

// ToolParamsSummaryVersion identifies the additive transcript schema used for
// redacted tool-call parameters.
const ToolParamsSummaryVersion = 1

// SummarizeToolParams returns a deterministic, transcript-safe parameter map.
// Raw parameter values are never copied into the returned map.
func SummarizeToolParams(params map[string]any) map[string]ToolParamSummary {
	out := make(map[string]ToolParamSummary, len(params))
	for _, key := range sortedParamKeys(params) {
		out[key] = summarizeToolParamValue(params[key])
	}
	return out
}

func sortedParamKeys(params map[string]any) []string {
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func summarizeToolParamValue(value any) ToolParamSummary {
	typeName := toolParamTypeName(value)
	var encoded []byte
	if s, ok := value.(string); ok {
		typeName = "string"
		encoded = []byte(s)
	} else {
		var err error
		encoded, err = json.Marshal(value)
		if err != nil {
			encoded = opaqueUnsupportedToolParamMetadata(typeName, err)
		}
	}

	sum := sha256.Sum256(encoded)
	return ToolParamSummary{
		Type:       typeName,
		Redacted:   true,
		ByteLength: len(encoded),
		SHA256:     hex.EncodeToString(sum[:]),
	}
}

func toolParamTypeName(value any) string {
	if value == nil {
		return "<nil>"
	}
	return reflect.TypeOf(value).String()
}

func opaqueUnsupportedToolParamMetadata(typeName string, err error) []byte {
	failure := "json_marshal_failed"
	var unsupportedType *json.UnsupportedTypeError
	var unsupportedValue *json.UnsupportedValueError
	switch {
	case errors.As(err, &unsupportedType):
		failure = "json_unsupported_type"
	case errors.As(err, &unsupportedValue):
		failure = "json_unsupported_value"
	}

	encoded, marshalErr := json.Marshal(struct {
		Type    string `json:"type"`
		Failure string `json:"failure"`
	}{
		Type:    typeName,
		Failure: failure,
	})
	if marshalErr != nil {
		return []byte("json_marshal_failed")
	}
	return encoded
}
