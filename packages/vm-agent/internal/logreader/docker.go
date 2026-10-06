// Docker container discovery and log reading for the node log reader.
package logreader

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ContainerInfo is the lightweight container shape exposed to the control plane.
type ContainerInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Image  string `json:"image"`
	State  string `json:"state"`
	Status string `json:"status"`
}

// ListContainers returns the running containers reported by `docker ps`.
func (r *Reader) ListContainers(ctx context.Context) ([]ContainerInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	args := []string{"ps", "--format", "{{json .}}"}
	cmd := r.exec(ctx, "docker", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w: %s", err, strings.TrimSpace(string(out)))
	}

	var containers []ContainerInfo
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var raw struct {
			ID     string `json:"ID"`
			Names  string `json:"Names"`
			Image  string `json:"Image"`
			State  string `json:"State"`
			Status string `json:"Status"`
		}
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			slog.Warn("failed to parse docker container listing", "error", err)
			continue
		}
		name := strings.TrimPrefix(raw.Names, "/")
		if name == "" {
			continue
		}
		containers = append(containers, ContainerInfo{
			ID:     raw.ID,
			Name:   name,
			Image:  raw.Image,
			State:  raw.State,
			Status: raw.Status,
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan docker ps output: %w", err)
	}
	return containers, nil
}

// readDockerLogs reads Docker container logs through docker logs so json-file
// and journald-backed containers are both visible.
func (r *Reader) readDockerLogs(ctx context.Context, filter LogFilter, limit int) ([]LogEntry, *string, error) {
	var containers []string
	if filter.Container != "" {
		containers = []string{filter.Container}
	} else {
		list, err := r.ListContainers(ctx)
		if err != nil {
			return nil, nil, err
		}
		for _, container := range list {
			containers = append(containers, container.Name)
		}
	}

	var allEntries []LogEntry
	for _, container := range containers {
		entries, err := r.readDockerContainerLogs(ctx, filter, container, limit)
		if err != nil {
			slog.Warn("failed to read docker container logs", "container", container, "error", err)
			continue
		}
		allEntries = append(allEntries, entries...)
	}

	sort.Slice(allEntries, func(i, j int) bool {
		return allEntries[i].Timestamp > allEntries[j].Timestamp
	})

	var nextCursor *string
	if len(allEntries) > limit {
		cursor := allEntries[limit-1].Timestamp
		nextCursor = &cursor
		allEntries = allEntries[:limit]
	} else if len(allEntries) > 0 {
		cursor := allEntries[len(allEntries)-1].Timestamp
		nextCursor = &cursor
	}

	return allEntries, nextCursor, nil
}

func (r *Reader) readDockerContainerLogs(ctx context.Context, filter LogFilter, container string, limit int) ([]LogEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	args := []string{
		"logs",
		"--timestamps",
		"--tail", strconv.Itoa(limit),
	}
	if filter.Since != "" {
		args = append(args, "--since", normalizeTimeArg(filter.Since))
	}
	until := filter.Until
	if until == "" && filter.Cursor != "" {
		until = filter.Cursor
	}
	if until != "" {
		args = append(args, "--until", normalizeTimeArg(until))
	}
	args = append(args, container)

	cmd := r.exec(ctx, "docker", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("docker logs: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return parseDockerLogsOutput(string(out), container), nil
}

func parseDockerLogsOutput(output, container string) []LogEntry {
	var entries []LogEntry
	scanner := bufio.NewScanner(strings.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}

		timestamp, message := splitDockerTimestamp(line)
		if timestamp == "" {
			timestamp = time.Now().UTC().Format(time.RFC3339Nano)
			message = line
		}
		entries = append(entries, LogEntry{
			Timestamp: timestamp,
			Level:     inferDockerLogLevel(message),
			Source:    "docker:" + container,
			Message:   message,
			Metadata: map[string]any{
				"container": container,
			},
		})
	}
	return entries
}

func splitDockerTimestamp(line string) (string, string) {
	parts := strings.SplitN(line, " ", 2)
	if len(parts) != 2 {
		return "", line
	}
	ts := strings.TrimSpace(parts[0])
	if parsed, err := time.Parse(time.RFC3339Nano, ts); err == nil {
		return parsed.UTC().Format(time.RFC3339Nano), parts[1]
	}
	return "", line
}

func inferDockerLogLevel(message string) string {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "error") || strings.Contains(lower, "fatal") || strings.Contains(lower, "panic"):
		return "error"
	case strings.Contains(lower, "warn"):
		return "warn"
	case strings.Contains(lower, "debug"):
		return "debug"
	default:
		return "info"
	}
}
