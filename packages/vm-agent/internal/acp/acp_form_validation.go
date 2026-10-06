package acp

import (
	"encoding/json"
	"math"
	"regexp"
	"unicode/utf8"
)

type acpFormLimits struct {
	schemaBytes int
	properties  int
	enum        int
	answerBytes int
	stringBytes int
	keyChars    int
	labelChars  int
}

var acpFormFieldKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

func formLimits(config AcpInteractionRuntimeConfig) acpFormLimits {
	return acpFormLimits{config.FormSchemaMaxBytes, config.FormSchemaMaxProperties,
		config.FormSchemaMaxEnum, config.AnswerMaxBytes, config.AnswerStringMaxBytes,
		config.OptionIDMaxChars, config.OptionNameMaxChars}
}

func formRecord(value any) (map[string]any, bool) {
	result, ok := value.(map[string]any)
	return result, ok
}

func formOnlyKeys(value map[string]any, allowed ...string) bool {
	keys := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		keys[key] = true
	}
	for key := range value {
		if !keys[key] {
			return false
		}
	}
	return true
}

func formText(value any, max int) bool {
	text, ok := value.(string)
	return ok && utf8.RuneCountInString(text) <= max
}

func formOptionalText(value map[string]any, key string, max int) bool {
	item, found := value[key]
	return !found || formText(item, max)
}

func formUint(value map[string]any, key string) bool {
	item, found := value[key]
	if !found {
		return true
	}
	number, ok := item.(float64)
	return ok && number >= 0 && number <= 9007199254740991 && math.Trunc(number) == number
}

func formChoices(value any, limits acpFormLimits, titled bool) bool {
	items, ok := value.([]any)
	if !ok || len(items) == 0 || len(items) > limits.enum {
		return false
	}
	seen := map[string]bool{}
	for _, item := range items {
		if !titled {
			label, ok := item.(string)
			if !ok || !formText(label, limits.keyChars) || seen[label] {
				return false
			}
			seen[label] = true
			continue
		}
		choice, ok := formRecord(item)
		if !ok || !formOnlyKeys(choice, "const", "title", "description", "_meta") ||
			!formText(choice["const"], limits.keyChars) || !formText(choice["title"], limits.labelChars) ||
			!formOptionalText(choice, "description", limits.schemaBytes) {
			return false
		}
		if metaValue, exists := choice["_meta"]; exists {
			meta, ok := formRecord(metaValue)
			if !ok || !formOnlyKeys(meta, "_claude/askUserQuestionOption") {
				return false
			}
			preview, ok := formRecord(meta["_claude/askUserQuestionOption"])
			if !ok || !formOnlyKeys(preview, "preview") || !formText(preview["preview"], limits.schemaBytes) {
				return false
			}
		}
		label := choice["const"].(string)
		if seen[label] {
			return false
		}
		seen[label] = true
	}
	return true
}

func formMeta(value any, fieldType string, limits acpFormLimits) bool {
	if value == nil {
		return true
	}
	meta, ok := formRecord(value)
	if !ok || len(meta) != 1 || fieldType != "string" {
		return false
	}
	if custom, ok := formRecord(meta["_askUserQuestionCustomAnswer"]); ok {
		return formOnlyKeys(custom, "questionId", "isCustomAnswer") &&
			formText(custom["questionId"], limits.keyChars) && custom["isCustomAnswer"] == true
	}
	if codex, ok := formRecord(meta["codex"]); ok {
		return formOnlyKeys(codex, "isOther", "isSecret", "questionId", "role") &&
			(!hasFormKey(codex, "isOther") || isFormBool(codex["isOther"])) &&
			(!hasFormKey(codex, "isSecret") || isFormBool(codex["isSecret"])) &&
			(!hasFormKey(codex, "questionId") || formText(codex["questionId"], limits.keyChars)) &&
			(!hasFormKey(codex, "role") || codex["role"] == "user_note")
	}
	return false
}

func hasFormKey(value map[string]any, key string) bool { _, ok := value[key]; return ok }
func isFormBool(value any) bool                        { _, ok := value.(bool); return ok }

func validateAcpFormField(field map[string]any, limits acpFormLimits) bool {
	fieldType, ok := field["type"].(string)
	if !ok || !formOptionalText(field, "title", limits.labelChars) || !formOptionalText(field, "description", limits.schemaBytes) ||
		(hasFormKey(field, "_meta") && field["_meta"] == nil) ||
		!formMeta(field["_meta"], fieldType, limits) {
		return false
	}
	switch fieldType {
	case "string":
		if !formOnlyKeys(field, "type", "title", "description", "default", "_meta", "minLength", "maxLength", "enum", "oneOf") ||
			!formUint(field, "minLength") || !formUint(field, "maxLength") {
			return false
		}
		if hasFormKey(field, "minLength") && hasFormKey(field, "maxLength") &&
			field["minLength"].(float64) > field["maxLength"].(float64) {
			return false
		}
		if hasFormKey(field, "enum") && hasFormKey(field, "oneOf") {
			return false
		}
		if hasFormKey(field, "enum") && !formChoices(field["enum"], limits, false) {
			return false
		}
		if hasFormKey(field, "oneOf") && !formChoices(field["oneOf"], limits, true) {
			return false
		}
	case "number", "integer":
		if !formOnlyKeys(field, "type", "title", "description", "default", "_meta", "minimum", "maximum") {
			return false
		}
		for _, key := range []string{"minimum", "maximum"} {
			if hasFormKey(field, key) {
				number, ok := field[key].(float64)
				if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
					return false
				}
			}
		}
		if hasFormKey(field, "minimum") && hasFormKey(field, "maximum") &&
			field["minimum"].(float64) > field["maximum"].(float64) {
			return false
		}
	case "boolean":
		if !formOnlyKeys(field, "type", "title", "description", "default", "_meta") {
			return false
		}
	case "array":
		if !formOnlyKeys(field, "type", "title", "description", "default", "_meta", "items", "minItems", "maxItems") ||
			!formUint(field, "minItems") || !formUint(field, "maxItems") {
			return false
		}
		if hasFormKey(field, "minItems") && hasFormKey(field, "maxItems") &&
			field["minItems"].(float64) > field["maxItems"].(float64) {
			return false
		}
		items, ok := formRecord(field["items"])
		if !ok || !formOnlyKeys(items, "type", "enum", "anyOf") ||
			(hasFormKey(items, "enum") == hasFormKey(items, "anyOf")) ||
			(hasFormKey(items, "type") && items["type"] != "string") {
			return false
		}
		if hasFormKey(items, "enum") && !formChoices(items["enum"], limits, false) {
			return false
		}
		if hasFormKey(items, "anyOf") && !formChoices(items["anyOf"], limits, true) {
			return false
		}
	default:
		return false
	}
	if value, ok := field["default"]; ok {
		return validateAcpFormValue(field, value, limits)
	}
	return true
}

func validateAcpFormSchema(schema map[string]any, limits acpFormLimits) bool {
	encoded, err := json.Marshal(schema)
	if err != nil || len(encoded) > limits.schemaBytes || !formOnlyKeys(schema, "type", "title", "description", "properties", "required") ||
		schema["type"] != "object" || !formOptionalText(schema, "title", limits.labelChars) ||
		!formOptionalText(schema, "description", limits.schemaBytes) {
		return false
	}
	properties, ok := formRecord(schema["properties"])
	if !ok || len(properties) == 0 || len(properties) > limits.properties {
		return false
	}
	for key, value := range properties {
		field, ok := formRecord(value)
		if key == "__proto__" || len(key) > limits.keyChars || !acpFormFieldKeyPattern.MatchString(key) || !ok ||
			!validateAcpFormField(field, limits) {
			return false
		}
	}
	if required, ok := schema["required"]; ok {
		items, ok := required.([]any)
		if !ok {
			return false
		}
		seen := map[string]bool{}
		for _, item := range items {
			key, ok := item.(string)
			if !ok || seen[key] || !hasFormKey(properties, key) {
				return false
			}
			seen[key] = true
		}
	}
	return true
}

func formAllowedChoices(field map[string]any) map[string]bool {
	value := field["enum"]
	titled := false
	if value == nil {
		value, titled = field["oneOf"], true
	}
	if field["type"] == "array" {
		items, _ := formRecord(field["items"])
		value, titled = items["enum"], false
		if value == nil {
			value, titled = items["anyOf"], true
		}
	}
	if value == nil {
		return nil
	}
	result := map[string]bool{}
	for _, item := range value.([]any) {
		if titled {
			choice, _ := formRecord(item)
			result[choice["const"].(string)] = true
		} else {
			result[item.(string)] = true
		}
	}
	return result
}

func validateAcpFormValue(field map[string]any, value any, limits acpFormLimits) bool {
	switch field["type"] {
	case "string":
		text, ok := value.(string)
		if !ok || len([]byte(text)) > limits.stringBytes {
			return false
		}
		length := utf8.RuneCountInString(text)
		if hasFormKey(field, "minLength") && float64(length) < field["minLength"].(float64) {
			return false
		}
		if hasFormKey(field, "maxLength") && float64(length) > field["maxLength"].(float64) {
			return false
		}
		allowed := formAllowedChoices(field)
		return allowed == nil || allowed[text]
	case "number", "integer":
		number, ok := value.(float64)
		if !ok || math.IsNaN(number) || math.IsInf(number, 0) ||
			(field["type"] == "integer" && (math.Trunc(number) != number || math.Abs(number) > 9007199254740991)) {
			return false
		}
		if hasFormKey(field, "minimum") && number < field["minimum"].(float64) {
			return false
		}
		return !hasFormKey(field, "maximum") || number <= field["maximum"].(float64)
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "array":
		items, ok := value.([]any)
		if !ok || len(items) > limits.enum {
			return false
		}
		if hasFormKey(field, "minItems") && float64(len(items)) < field["minItems"].(float64) {
			return false
		}
		if hasFormKey(field, "maxItems") && float64(len(items)) > field["maxItems"].(float64) {
			return false
		}
		allowed, seen := formAllowedChoices(field), map[string]bool{}
		for _, item := range items {
			text, ok := item.(string)
			if !ok || len([]byte(text)) > limits.stringBytes || !allowed[text] || seen[text] {
				return false
			}
			seen[text] = true
		}
		return true
	}
	return false
}

func validateAcpFormAnswer(schema map[string]any, answer map[string]any, limits acpFormLimits) bool {
	if answer == nil || len(answer) == 0 {
		return false
	}
	encoded, err := json.Marshal(answer)
	if err != nil || len(encoded) > limits.answerBytes {
		return false
	}
	properties, _ := formRecord(schema["properties"])
	for key, value := range answer {
		field, ok := formRecord(properties[key])
		if !ok || !validateAcpFormValue(field, value, limits) {
			return false
		}
	}
	if required, ok := schema["required"].([]any); ok {
		for _, item := range required {
			if !hasFormKey(answer, item.(string)) {
				return false
			}
		}
	}
	return true
}
