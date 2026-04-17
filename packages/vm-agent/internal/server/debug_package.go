package server

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/workspace/vm-agent/internal/logreader"
	"github.com/workspace/vm-agent/internal/sysinfo"
)

// debugPackageTimeout is the maximum time to spend assembling the debug package.
var debugPackageTimeout = envDuration("DEBUG_PACKAGE_TIMEOUT", 60*time.Second)

// debugPackageLogLimit is the maximum number of log entries to include per source.
var debugPackageLogLimit = envInt("DEBUG_PACKAGE_LOG_LIMIT", 10000)

// handleDebugPackage serves GET /debug-package — streams a tar.gz archive containing
// all diagnostic data: logs (journald, cloud-init, Docker), metrics DB, events DB,
// system info snapshot, boot events, and command outputs like docker ps.
func (s *Server) handleDebugPackage(w http.ResponseWriter, r *http.Request) {
	if !s.requireNodeEventAuth(w, r) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), debugPackageTimeout)
	defer cancel()

	nodeID := s.config.NodeID
	timestamp := time.Now().UTC().Format("20060102-150405")
	filename := fmt.Sprintf("debug-%s-%s.tar.gz", nodeID, timestamp)

	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))

	gw := gzip.NewWriter(w)
	defer gw.Close()

	tw := tar.NewWriter(gw)
	defer tw.Close()

	// 1. Cloud-init logs (raw files)
	addFileToTar(tw, "/var/log/cloud-init.log", "cloud-init.log")
	addFileToTar(tw, "/var/log/cloud-init-output.log", "cloud-init-output.log")

	// 2. Journald logs — full system journal
	addCommandOutputToTar(ctx, tw, "journald-full.log",
		"journalctl", "--no-pager", "--output=short-iso", "-n", "50000")

	// 3. VM agent service logs
	addCommandOutputToTar(ctx, tw, "vm-agent.log",
		"journalctl", "--no-pager", "--output=short-iso", "-u", "vm-agent.service", "-n", "50000")

	// 4. Docker container logs via the log reader
	if s.logReader != nil {
		dockerResp, err := s.logReader.ReadLogs(ctx, logreader.LogFilter{
			Source: "docker",
			Level:  "debug",
			Limit:  debugPackageLogLimit,
		})
		if err != nil {
			slog.Warn("debug-package: failed to read docker logs", "error", err)
		} else if dockerResp != nil && len(dockerResp.Entries) > 0 {
			addJSONToTar(tw, "docker-logs.json", dockerResp.Entries)
		}
	}

	// 5. Docker ps output
	addCommandOutputToTar(ctx, tw, "docker-ps.txt",
		"docker", "ps", "-a", "--no-trunc")

	// 6. Docker inspect (all containers)
	addCommandOutputToTar(ctx, tw, "docker-inspect.json",
		"docker", "inspect", "--format={{json .}}")
	// Fallback: try docker inspect on all containers
	addCommandOutputToTar(ctx, tw, "docker-inspect-all.json",
		"sh", "-c", "docker ps -aq | xargs -r docker inspect 2>/dev/null || echo '[]'")

	// 7. System info snapshot
	if s.sysInfoCollector != nil {
		info, err := s.sysInfoCollector.Collect()
		if err != nil {
			slog.Warn("debug-package: failed to collect system info", "error", err)
		} else {
			addJSONToTar(tw, "system-info.json", info)
		}
	}

	// 8. Events database
	if s.eventStore != nil {
		if err := s.eventStore.Checkpoint(); err != nil {
			slog.Warn("debug-package: eventstore checkpoint failed", "error", err)
		}
		addFileToTar(tw, s.eventStore.DBPath(), fmt.Sprintf("events-%s.db", nodeID))
	}

	// 9. Metrics database
	if s.resourceMonitor != nil {
		if err := s.resourceMonitor.Checkpoint(); err != nil {
			slog.Warn("debug-package: resourcemon checkpoint failed", "error", err)
		}
		addFileToTar(tw, s.resourceMonitor.DBPath(), fmt.Sprintf("metrics-%s.db", nodeID))
	}

	// 10. Boot log entries
	if s.bootLogBroadcasters != nil {
		entries := s.getBootLogEntries()
		if len(entries) > 0 {
			addJSONToTar(tw, "boot-events.json", entries)
		}
	}

	// 11. System logs — dmesg, syslog
	addCommandOutputToTar(ctx, tw, "dmesg.log",
		"dmesg", "--time-format=iso", "-T")
	addFileToTar(tw, "/var/log/syslog", "syslog.log")

	// 12. Systemd unit status for key services
	addCommandOutputToTar(ctx, tw, "systemd-status.txt",
		"sh", "-c", "systemctl status vm-agent docker containerd --no-pager -l 2>&1 || true")

	// 13. Firewall rules
	addCommandOutputToTar(ctx, tw, "iptables.txt",
		"sh", "-c", "iptables -L -n -v 2>&1 || echo 'iptables not available'")

	// 14. Network info
	addCommandOutputToTar(ctx, tw, "network.txt",
		"sh", "-c", "ip addr show 2>&1; echo '---'; ip route show 2>&1; echo '---'; ss -tlnp 2>&1")

	// 15. Disk usage
	addCommandOutputToTar(ctx, tw, "disk-usage.txt",
		"sh", "-c", "df -h 2>&1; echo '---'; du -sh /var/lib/docker/* 2>/dev/null || true")

	// 16. Process list
	addCommandOutputToTar(ctx, tw, "processes.txt",
		"ps", "auxf")

	// 17. Manifest — metadata about this debug package
	manifest := map[string]interface{}{
		"nodeId":    nodeID,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"agent":     sysinfo.Version,
	}
	addJSONToTar(tw, "manifest.json", manifest)

	slog.Info("debug-package: assembled and streamed", "nodeId", nodeID)
}

// getBootLogEntries retrieves buffered boot log entries from all broadcasters.
func (s *Server) getBootLogEntries() []BootLogWSEntry {
	if s.bootLogBroadcasters == nil {
		return nil
	}
	s.bootLogBroadcasters.mu.Lock()
	defer s.bootLogBroadcasters.mu.Unlock()

	var all []BootLogWSEntry
	for _, b := range s.bootLogBroadcasters.broadcasters {
		if b == nil {
			continue
		}
		b.mu.RLock()
		all = append(all, b.entries...)
		b.mu.RUnlock()
	}
	return all
}

// addFileToTar adds a file from disk into the tar archive.
// Silently skips if the file doesn't exist or can't be read.
func addFileToTar(tw *tar.Writer, sourcePath, archiveName string) {
	f, err := os.Open(sourcePath)
	if err != nil {
		slog.Debug("debug-package: skipping file", "path", sourcePath, "error", err)
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		slog.Debug("debug-package: can't stat file", "path", sourcePath, "error", err)
		return
	}

	header := &tar.Header{
		Name:    archiveName,
		Size:    stat.Size(),
		Mode:    0644,
		ModTime: stat.ModTime(),
	}
	if err := tw.WriteHeader(header); err != nil {
		slog.Warn("debug-package: failed to write tar header", "name", archiveName, "error", err)
		return
	}
	if _, err := io.Copy(tw, f); err != nil {
		slog.Warn("debug-package: failed to write file to tar", "name", archiveName, "error", err)
	}
}

// addCommandOutputToTar runs a command and adds its stdout+stderr to the tar archive.
// Silently skips if the command fails.
func addCommandOutputToTar(ctx context.Context, tw *tar.Writer, archiveName string, name string, args ...string) {
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Include the error in the output rather than skipping — partial output is still useful
		errMsg := fmt.Sprintf("\n--- command error: %v ---\n", err)
		out = append(out, []byte(errMsg)...)
	}
	if len(out) == 0 {
		return
	}

	header := &tar.Header{
		Name:    archiveName,
		Size:    int64(len(out)),
		Mode:    0644,
		ModTime: time.Now(),
	}
	if err := tw.WriteHeader(header); err != nil {
		slog.Warn("debug-package: failed to write tar header", "name", archiveName, "error", err)
		return
	}
	if _, err := tw.Write(out); err != nil {
		slog.Warn("debug-package: failed to write command output to tar", "name", archiveName, "error", err)
	}
}

// addJSONToTar marshals data to pretty JSON and adds it to the tar archive.
func addJSONToTar(tw *tar.Writer, archiveName string, data interface{}) {
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		slog.Warn("debug-package: failed to marshal JSON", "name", archiveName, "error", err)
		return
	}

	header := &tar.Header{
		Name:    archiveName,
		Size:    int64(len(b)),
		Mode:    0644,
		ModTime: time.Now(),
	}
	if err := tw.WriteHeader(header); err != nil {
		slog.Warn("debug-package: failed to write tar header", "name", archiveName, "error", err)
		return
	}
	if _, err := tw.Write(b); err != nil {
		slog.Warn("debug-package: failed to write JSON to tar", "name", archiveName, "error", err)
	}
}

// envDuration reads a duration from an environment variable, with a fallback default.
// Duplicated from logreader to avoid cross-package dependency for a trivial helper.
func envDuration(key string, defaultVal time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return defaultVal
}

// envInt reads an int from an environment variable, with a fallback default.
func envInt(key string, defaultVal int) int {
	if v := os.Getenv(key); v != "" {
		n := 0
		for _, c := range v {
			if c < '0' || c > '9' {
				return defaultVal
			}
			n = n*10 + int(c-'0')
		}
		return n
	}
	return defaultVal
}
