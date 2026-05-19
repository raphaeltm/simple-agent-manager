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
