package cli

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

func parseSubmitOptions(parsed parsedArgs) (TaskSubmitOptions, error) {
	if flagValue(parsed.Flags, "model") != "" {
		return TaskSubmitOptions{}, errors.New("--model is reserved, but the current task submit API does not accept a per-dispatch model yet; use --agent-profile for configured model selection")
	}
	resource, err := parseResourceRequirementFlags(parsed)
	if err != nil {
		return TaskSubmitOptions{}, err
	}
	return TaskSubmitOptions{
		Skill:          flagValue(parsed.Flags, "skill"),
		Agent:          flagValue(parsed.Flags, "agent"),
		AgentProfile:   flagValue(parsed.Flags, "agent-profile", "agent-profile-id"),
		ContextSummary: flagValue(parsed.Flags, "context-summary"),
		Devcontainer:   flagValue(parsed.Flags, "devcontainer-config", "devcontainer-config-name"),
		Mode:           flagValue(parsed.Flags, "mode"),
		Node:           flagValue(parsed.Flags, "node", "node-id"),
		ParentTask:     flagValue(parsed.Flags, "parent-task", "parent-task-id"),
		Provider:       flagValue(parsed.Flags, "provider"),
		Resource:       resource,
		VMLocation:     flagValue(parsed.Flags, "vm-location"),
		VMSize:         flagValue(parsed.Flags, "vm-size"),
		Workspace:      flagValue(parsed.Flags, "workspace", "workspace-profile"),
	}, nil
}

// retiredResourceFlags are flags SAM used to accept and has since removed. They fail
// loudly instead of being silently dropped by the permissive parser: a caller relying on
// an old cap would otherwise believe it was applied.
var retiredResourceFlags = map[string]string{
	"max-co-tenants": "SAM no longer caps workspaces per node by count; placement uses --min-vcpu, --min-memory-gb, --min-disk-gb, and --exclusive-node",
}

func parseResourceRequirementFlags(parsed parsedArgs) (*ResourceRequirements, error) {
	for name, reason := range retiredResourceFlags {
		if _, present := parsed.Flags[name]; present || hasValuelessFlagOccurrence(parsed, name) {
			return nil, fmt.Errorf("--%s was removed: %s", name, reason)
		}
	}
	resource := ResourceRequirements{}
	set := false

	if value, present, err := parseOptionalPositiveFloat(parsed, "min-vcpu", 1000); err != nil {
		return nil, err
	} else if present {
		resource.MinVCPU = &value
		set = true
	}
	if value, present, err := parseOptionalPositiveFloat(parsed, "min-memory-gb", 1024); err != nil {
		return nil, err
	} else if present {
		resource.MinMemoryGB = &value
		set = true
	}
	if value, present, err := parseOptionalNonNegativeFloat(parsed, "min-disk-gb", 1024); err != nil {
		return nil, err
	} else if present {
		resource.MinDiskGB = &value
		set = true
	}
	if value, present, err := parseOptionalBoolFlag(parsed, "exclusive-node"); err != nil {
		return nil, err
	} else if present {
		resource.ExclusiveNode = &value
		set = true
	}

	if !set {
		return nil, nil
	}
	return &resource, nil
}

const maxSafeInteger = 1<<53 - 1

func parseOptionalPositiveFloat(parsed parsedArgs, name string, unitScale float64) (float64, bool, error) {
	raw, present, err := resourceFlagValue(parsed, name)
	if err != nil || !present {
		return 0, present, err
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return 0, true, fmt.Errorf("--%s must be a finite positive number", name)
	}
	if err := validateRoundedUnitBound(name, value, unitScale); err != nil {
		return 0, true, err
	}
	return value, true, nil
}

func parseOptionalNonNegativeFloat(parsed parsedArgs, name string, unitScale float64) (float64, bool, error) {
	raw, present, err := resourceFlagValue(parsed, name)
	if err != nil || !present {
		return 0, present, err
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0, true, fmt.Errorf("--%s must be a finite non-negative number", name)
	}
	if err := validateRoundedUnitBound(name, value, unitScale); err != nil {
		return 0, true, err
	}
	return value, true, nil
}

func resourceFlagValue(parsed parsedArgs, name string) (string, bool, error) {
	if hasValuelessFlagOccurrence(parsed, name) {
		return "", true, fmt.Errorf("--%s requires a numeric value", name)
	}
	raw, present := parsed.Flags[name]
	if !present {
		return "", false, nil
	}
	return raw, true, nil
}

func validateRoundedUnitBound(name string, value float64, unitScale float64) error {
	if value > float64(maxSafeInteger)/unitScale {
		return fmt.Errorf("--%s is too large", name)
	}
	units := math.Ceil(value * unitScale)
	if math.IsInf(units, 0) || units > float64(maxSafeInteger) {
		return fmt.Errorf("--%s is too large", name)
	}
	return nil
}

func parseOptionalBoolFlag(parsed parsedArgs, name string) (bool, bool, error) {
	value, present, err := booleanFlagOccurrenceValue(parsed, name)
	if err != nil || present {
		return value, present, err
	}
	return false, false, nil
}

func hasValuelessFlagOccurrence(parsed parsedArgs, name string) bool {
	for _, occurrence := range parsed.FlagOccurrences {
		if occurrence.Name == name && !occurrence.HasValue {
			return true
		}
	}
	return false
}

func booleanFlagOccurrenceValue(parsed parsedArgs, name string) (bool, bool, error) {
	var matched *flagOccurrence
	for i := range parsed.FlagOccurrences {
		occurrence := &parsed.FlagOccurrences[i]
		if occurrence.Name != name {
			continue
		}
		if matched != nil {
			return false, true, fmt.Errorf("--%s may only be specified once", name)
		}
		matched = occurrence
	}
	if matched == nil {
		return false, false, nil
	}
	if !matched.HasValue {
		return true, true, nil
	}
	value, err := strconv.ParseBool(strings.TrimSpace(matched.Value))
	if err != nil {
		return false, true, fmt.Errorf("--%s must be true or false", name)
	}
	return value, true, nil
}
