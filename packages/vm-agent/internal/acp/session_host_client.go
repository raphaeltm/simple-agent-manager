package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// --- sessionHostClient: ACP SDK client interface ---

// sessionHostClient implements the acp-go-sdk Client interface.
// Instead of writing to a single WebSocket, it broadcasts to all viewers.
type sessionHostClient struct {
	host        *SessionHost
	processedCh chan struct{} // Signaled after each notification handler completes (used by orderedPipe).
}

// signalProcessed signals the orderedPipe that this notification handler has
// completed, allowing the next notification to be delivered to the SDK.
func (c *sessionHostClient) signalProcessed() {
	if c.processedCh != nil {
		select {
		case c.processedCh <- struct{}{}:
		default:
			// Buffer already has a pending signal; this can happen if two
			// notifications were dispatched before backpressure took effect.
			slog.Debug("orderedPipe: processedCh already has pending signal, skipping")
		}
	}
}

func (c *sessionHostClient) SessionUpdate(_ context.Context, params acpsdk.SessionNotification) error {
	defer c.signalProcessed()

	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "session/update",
		"params":  params,
	})
	if err != nil {
		slog.Warn("session/update: marshal failed, skipping broadcast",
			"error", err)
	} else {
		c.host.broadcastMessage(data)
	}

	// Persist chat messages to the control plane via the message reporter.
	if c.host.config.MessageReporter != nil {
		msgs := ExtractMessages(params)
		for _, m := range msgs {
			if err := c.host.config.MessageReporter.Enqueue(MessageReportEntry{
				MessageID:    m.MessageID,
				Role:         m.Role,
				Content:      m.Content,
				ToolMetadata: m.ToolMetadata,
			}); err != nil {
				slog.Warn("messagereport: enqueue failed (non-blocking)",
					"messageId", m.MessageID, "error", err)
			}
		}
	}

	return nil
}

func (c *sessionHostClient) RequestPermission(_ context.Context, params acpsdk.RequestPermissionRequest) (acpsdk.RequestPermissionResponse, error) {
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "permission/request",
		"params":  params,
	})
	if err != nil {
		return acpsdk.RequestPermissionResponse{}, fmt.Errorf("failed to marshal permission request: %w", err)
	}
	c.host.broadcastMessage(data)

	mode := c.host.permissionMode
	if mode == "" {
		mode = "default"
	}
	slog.Info("Permission request", "mode", mode, "optionsCount", len(params.Options))

	if len(params.Options) > 0 {
		return acpsdk.RequestPermissionResponse{
			Outcome: acpsdk.NewRequestPermissionOutcomeSelected(params.Options[0].OptionId),
		}, nil
	}
	return acpsdk.RequestPermissionResponse{
		Outcome: acpsdk.NewRequestPermissionOutcomeCancelled(),
	}, nil
}

func (c *sessionHostClient) ReadTextFile(ctx context.Context, params acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
	if params.Path == "" {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("file path is required")
	}
	if strings.ContainsRune(params.Path, 0) {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("file path contains null byte")
	}

	containerID, err := c.host.config.ContainerResolver()
	if err != nil {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("failed to resolve container: %w", err)
	}

	timeout := c.host.config.FileExecTimeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	content, stderr, err := execInContainer(execCtx, containerID, c.host.config.ContainerUser, "", "cat", params.Path)
	if err != nil {
		slog.Error("ReadTextFile error", "path", params.Path, "error", err, "stderr", stderr)
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("failed to read file %q: %v", params.Path, err)
	}

	maxSize := c.host.config.FileMaxSize
	if maxSize == 0 {
		maxSize = 1048576
	}
	if len(content) > maxSize {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("file %q exceeds maximum size of %d bytes", params.Path, maxSize)
	}

	content = applyLineLimit(content, params.Line, params.Limit)

	return acpsdk.ReadTextFileResponse{Content: content}, nil
}

func (c *sessionHostClient) WriteTextFile(ctx context.Context, params acpsdk.WriteTextFileRequest) (acpsdk.WriteTextFileResponse, error) {
	if params.Path == "" {
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("file path is required")
	}
	if strings.ContainsRune(params.Path, 0) {
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("file path contains null byte")
	}

	maxSize := c.host.config.FileMaxSize
	if maxSize == 0 {
		maxSize = 1048576
	}
	if len(params.Content) > maxSize {
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("content exceeds maximum size of %d bytes", maxSize)
	}

	containerID, err := c.host.config.ContainerResolver()
	if err != nil {
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("failed to resolve container: %w", err)
	}

	timeout := c.host.config.FileExecTimeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	dockerArgs := []string{"exec", "-i"}
	if c.host.config.ContainerUser != "" {
		dockerArgs = append(dockerArgs, "-u", c.host.config.ContainerUser)
	}
	dockerArgs = append(dockerArgs, containerID, "tee", params.Path)

	cmd := exec.CommandContext(execCtx, "docker", dockerArgs...)
	cmd.Stdin = strings.NewReader(params.Content)

	var stderrBuf bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = &stderrBuf

	if err := cmd.Run(); err != nil {
		stderrStr := strings.TrimSpace(stderrBuf.String())
		slog.Error("WriteTextFile error", "path", params.Path, "error", err, "stderr", stderrStr)
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("failed to write file %q: %v", params.Path, err)
	}

	return acpsdk.WriteTextFileResponse{}, nil
}

func (c *sessionHostClient) CreateTerminal(_ context.Context, _ acpsdk.CreateTerminalRequest) (acpsdk.CreateTerminalResponse, error) {
	return acpsdk.CreateTerminalResponse{}, fmt.Errorf("CreateTerminal not supported")
}

func (c *sessionHostClient) KillTerminal(_ context.Context, _ acpsdk.KillTerminalRequest) (acpsdk.KillTerminalResponse, error) {
	return acpsdk.KillTerminalResponse{}, fmt.Errorf("KillTerminal not supported")
}

func (c *sessionHostClient) TerminalOutput(_ context.Context, _ acpsdk.TerminalOutputRequest) (acpsdk.TerminalOutputResponse, error) {
	return acpsdk.TerminalOutputResponse{}, fmt.Errorf("TerminalOutput not supported")
}

func (c *sessionHostClient) ReleaseTerminal(_ context.Context, _ acpsdk.ReleaseTerminalRequest) (acpsdk.ReleaseTerminalResponse, error) {
	return acpsdk.ReleaseTerminalResponse{}, fmt.Errorf("ReleaseTerminal not supported")
}

func (c *sessionHostClient) WaitForTerminalExit(_ context.Context, _ acpsdk.WaitForTerminalExitRequest) (acpsdk.WaitForTerminalExitResponse, error) {
	return acpsdk.WaitForTerminalExitResponse{}, fmt.Errorf("WaitForTerminalExit not supported")
}
