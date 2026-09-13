package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

func writeOutput(w io.Writer, jsonMode bool, text string, value any) error {
	if jsonMode {
		content, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(w, string(content))
		return err
	}
	_, err := fmt.Fprintln(w, text)
	return err
}

func formatSubmitResponse(response SubmitTaskResponse) string {
	lines := []string{"Task submitted"}
	appendLine(&lines, "taskId", response.TaskID)
	appendLine(&lines, "sessionId", response.SessionID)
	appendLine(&lines, "branchName", response.BranchName)
	appendLine(&lines, "status", response.Status)
	return strings.Join(lines, "\n")
}

func formatTaskStatus(response TaskStatusResponse) string {
	lines := []string{}
	appendLine(&lines, "id", response.ID)
	appendLine(&lines, "title", response.Title)
	appendLine(&lines, "status", response.Status)
	appendLine(&lines, "executionStep", response.ExecutionStep)
	appendLine(&lines, "taskMode", response.TaskMode)
	appendLine(&lines, "requestedVmSize", formatLegacyVMSize(response.RequestedVMSize))
	appendPtrLine(&lines, "resourceRequirements", response.ResourceRequirementsJSON)
	appendLine(&lines, "resourceRequirementsSource", response.ResourceRequirementsSource)
	appendPtrLine(&lines, "outputBranch", response.OutputBranch)
	appendPtrLine(&lines, "outputPrUrl", response.OutputPRURL)
	appendPtrLine(&lines, "outputSummary", response.OutputSummary)
	appendPtrLine(&lines, "errorMessage", response.ErrorMessage)
	appendPtrLine(&lines, "finalizedAt", response.FinalizedAt)
	appendLine(&lines, "updatedAt", response.UpdatedAt)
	return strings.Join(lines, "\n")
}

func appendLine(lines *[]string, key string, value string) {
	if value != "" {
		*lines = append(*lines, fmt.Sprintf("%s: %s", key, value))
	}
}

func appendPtrLine(lines *[]string, key string, value *string) {
	if value != nil && *value != "" {
		appendLine(lines, key, *value)
	}
}

func formatLegacyVMSize(vmSize string) string {
	if vmSize == "" {
		return ""
	}
	return "unknown hardware (compatibility estimate: " + vmSize + ")"
}

func formatProfileWorkload(profile AgentProfile) string {
	if profile.ResourceRequirementsJSON != nil && strings.TrimSpace(*profile.ResourceRequirementsJSON) != "" {
		return summarizeResourceJSON(*profile.ResourceRequirementsJSON)
	}
	if profile.VMSizeOverride != "" {
		return "unknown hardware (compatibility estimate: " + profile.VMSizeOverride + ")"
	}
	if profile.VMSize != "" {
		return "unknown hardware (compatibility estimate: " + profile.VMSize + ")"
	}
	return ""
}

func formatNodeHardware(node Node) string {
	parts := []string{}
	if node.ProviderInstanceType != "" {
		parts = append(parts, node.ProviderInstanceType)
	}
	if node.ProviderInstanceVCPUCount != nil {
		parts = append(parts, formatFloat(*node.ProviderInstanceVCPUCount)+" vCPU")
	}
	if node.ProviderInstanceMemoryMB != nil {
		parts = append(parts, formatFloat(*node.ProviderInstanceMemoryMB)+" MB")
	}
	if node.ProviderInstanceDiskGB != nil {
		parts = append(parts, formatFloat(*node.ProviderInstanceDiskGB)+" GB disk")
	}
	if len(parts) > 0 {
		return strings.Join(parts, " / ")
	}
	return formatLegacyVMSize(node.VMSize)
}

func summarizeResourceJSON(raw string) string {
	var value map[string]any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return "unknown workload (malformed compatibility metadata)"
	}
	parts := []string{}
	if text := numberField(value, "minVcpu"); text != "" {
		parts = append(parts, text+" vCPU")
	}
	if text := numberField(value, "minMemoryGb"); text != "" {
		parts = append(parts, text+" GB memory")
	}
	if text := numberField(value, "minDiskGb"); text != "" {
		parts = append(parts, text+" GB disk")
	}
	if exclusive, ok := value["exclusiveNode"].(bool); ok {
		parts = append(parts, fmt.Sprintf("exclusive=%t", exclusive))
	}
	if text := numberField(value, "maxCoTenants"); text != "" {
		parts = append(parts, "max co-tenants "+text)
	}
	if len(parts) == 0 {
		return "unknown workload (compatibility metadata)"
	}
	return strings.Join(parts, ", ")
}

func numberField(value map[string]any, key string) string {
	number, ok := value[key].(float64)
	if !ok {
		return ""
	}
	return formatFloat(number)
}

func formatFloat(value float64) string {
	if value == float64(int64(value)) {
		return fmt.Sprintf("%d", int64(value))
	}
	return fmt.Sprintf("%.2f", value)
}
