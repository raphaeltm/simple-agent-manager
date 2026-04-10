package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// defaultUploadDestination is the default upload destination relative to the workdir.
// It resolves to /workspaces/.private/ which is outside the git tree.
const defaultUploadDestination = "../.private"

// safeFilenameRe allows only alphanumeric, dash, underscore, dot, and space in filenames.
// Rejects shell metacharacters, control characters, and other potentially dangerous chars.
var safeFilenameRe = regexp.MustCompile(`^[a-zA-Z0-9._\- ]+$`)

// FileUploadResponse describes the result of a file upload operation.
type FileUploadResponse struct {
	Files []UploadedFile `json:"files"`
}

// UploadedFile describes a single uploaded file.
type UploadedFile struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// handleFileUpload handles POST /workspaces/{workspaceId}/files/upload
// Accepts multipart/form-data with one or more file parts.
// Optional form field "destination" sets the target directory (relative to workdir).
// Defaults to "../.private" (outside the git tree).
func (s *Server) handleFileUpload(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	// Enforce request body size limit (batch max + overhead for multipart headers)
	maxBody := s.config.FileUploadBatchMaxBytes + 1024*1024 // 1MB overhead for headers
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)

	contentType := r.Header.Get("Content-Type")
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil || !strings.HasPrefix(mediaType, "multipart/") {
		writeError(w, http.StatusBadRequest, "Content-Type must be multipart/form-data")
		return
	}

	boundary := params["boundary"]
	if boundary == "" {
		writeError(w, http.StatusBadRequest, "missing multipart boundary")
		return
	}

	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	reader := multipart.NewReader(r.Body, boundary)
	destination := defaultUploadDestination
	var uploaded []UploadedFile
	var totalBytes int64

	ctx, cancel := context.WithTimeout(r.Context(), s.config.FileUploadTimeout)
	defer cancel()

	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			slog.Error("Error reading multipart part", "workspace", workspaceID, "error", err)
			writeError(w, http.StatusBadRequest, "failed to read multipart data")
			return
		}

		fieldName := part.FormName()

		// Handle the "destination" text field
		if fieldName == "destination" {
			destBytes, readErr := io.ReadAll(io.LimitReader(part, 4096))
			part.Close()
			if readErr != nil {
				writeError(w, http.StatusBadRequest, "failed to read destination field")
				return
			}
			dest := strings.TrimSpace(string(destBytes))
			if dest != "" {
				if err := sanitizeFilePath(dest); err != nil {
					writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid destination: %s", err.Error()))
					return
				}
				destination = dest
			}
			continue
		}

		// Handle file parts
		if fieldName != "files" && fieldName != "file" {
			part.Close()
			continue
		}

		fileName := part.FileName()
		if fileName == "" {
			part.Close()
			continue
		}

		// Sanitize the file name — use only the base name to prevent path injection
		fileName = filepath.Base(fileName)
		if fileName == "." || fileName == ".." {
			part.Close()
			writeError(w, http.StatusBadRequest, "invalid file name")
			return
		}
		// Reject filenames with shell metacharacters or control characters
		if !safeFilenameRe.MatchString(fileName) {
			part.Close()
			writeError(w, http.StatusBadRequest, "file name contains disallowed characters")
			return
		}

		// Read file content with size limit
		limitedReader := io.LimitReader(part, s.config.FileUploadMaxBytes+1)
		fileData, readErr := io.ReadAll(limitedReader)
		part.Close()
		if readErr != nil {
			slog.Error("Error reading file part", "workspace", workspaceID, "file", fileName, "error", readErr)
			writeError(w, http.StatusBadRequest, fmt.Sprintf("failed to read file: %s", fileName))
			return
		}

		fileSize := int64(len(fileData))
		if fileSize > s.config.FileUploadMaxBytes {
			writeError(w, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("file %q exceeds maximum size of %d bytes", fileName, s.config.FileUploadMaxBytes))
			return
		}

		totalBytes += fileSize
		if totalBytes > s.config.FileUploadBatchMaxBytes {
			writeError(w, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("total upload exceeds maximum batch size of %d bytes", s.config.FileUploadBatchMaxBytes))
			return
		}

		// Build the destination path
		destPath := filepath.Join(destination, fileName)
		destDir := filepath.Dir(destPath)

		// Step 1: Create destination directory (no shell interpolation of user paths)
		mkdirArgs := []string{"exec"}
		if user != "" {
			mkdirArgs = append(mkdirArgs, "-u", user)
		}
		if workDir != "" {
			mkdirArgs = append(mkdirArgs, "-w", workDir)
		}
		mkdirArgs = append(mkdirArgs, containerID, "mkdir", "-p", destDir)

		mkdirCmd := exec.CommandContext(ctx, "docker", mkdirArgs...)
		var mkdirStderr bytes.Buffer
		mkdirCmd.Stderr = &mkdirStderr
		if err := mkdirCmd.Run(); err != nil {
			slog.Error("Failed to create destination directory",
				"workspace", workspaceID,
				"destDir", destDir,
				"error", err,
				"stderr", strings.TrimSpace(mkdirStderr.String()),
			)
			writeError(w, http.StatusInternalServerError, "failed to create destination directory")
			return
		}

		// Step 2: Write file via docker exec with stdin (no shell interpolation)
		writeArgs := []string{"exec", "-i"}
		if user != "" {
			writeArgs = append(writeArgs, "-u", user)
		}
		if workDir != "" {
			writeArgs = append(writeArgs, "-w", workDir)
		}
		writeArgs = append(writeArgs, containerID, "tee", destPath)

		writeCmd := exec.CommandContext(ctx, "docker", writeArgs...)
		writeCmd.Stdin = bytes.NewReader(fileData)
		// Discard tee's stdout (it copies stdin to both file and stdout)
		writeCmd.Stdout = io.Discard
		var stderrBuf bytes.Buffer
		writeCmd.Stderr = &stderrBuf

		if err := writeCmd.Run(); err != nil {
			stderrStr := strings.TrimSpace(stderrBuf.String())
			slog.Error("Failed to write file to container",
				"workspace", workspaceID,
				"file", fileName,
				"destPath", destPath,
				"error", err,
				"stderr", stderrStr,
			)
			writeError(w, http.StatusInternalServerError, "failed to write file")
			return
		}

		uploaded = append(uploaded, UploadedFile{
			Name: fileName,
			Path: destPath,
			Size: fileSize,
		})

		slog.Info("File uploaded to workspace",
			"workspace", workspaceID,
			"file", fileName,
			"destPath", destPath,
			"size", fileSize,
		)
	}

	if len(uploaded) == 0 {
		writeError(w, http.StatusBadRequest, "no files provided in upload")
		return
	}

	writeJSON(w, http.StatusOK, FileUploadResponse{Files: uploaded})
}

// handleFileDownload handles GET /workspaces/{workspaceId}/files/download?path=...
// Streams the file content from the container with Content-Disposition: attachment.
func (s *Server) handleFileDownload(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		writeError(w, http.StatusBadRequest, "path query parameter is required")
		return
	}
	if err := sanitizeFilePath(filePath); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	workDir, err = s.resolveWorktreeWorkDir(r, workspaceID, containerID, user, workDir)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.FileDownloadTimeout)
	defer cancel()

	// First check file exists and get size (no shell interpolation — pass path as arg)
	sizeOutput, _, statErr := s.execInContainer(ctx, containerID, user, workDir, "stat", "-c", "%s", filePath)
	if statErr != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}

	sizeStr := strings.TrimSpace(sizeOutput)
	var fileSize int64
	if _, err := fmt.Sscanf(sizeStr, "%d", &fileSize); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to determine file size")
		return
	}

	if fileSize > s.config.FileDownloadMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("file exceeds maximum download size of %d bytes", s.config.FileDownloadMaxBytes))
		return
	}

	// Read file content via docker exec cat (no shell interpolation)
	dockerArgs := []string{"exec", "-i"}
	if user != "" {
		dockerArgs = append(dockerArgs, "-u", user)
	}
	if workDir != "" {
		dockerArgs = append(dockerArgs, "-w", workDir)
	}
	dockerArgs = append(dockerArgs, containerID, "cat", "--", filePath)

	cmd := exec.CommandContext(ctx, "docker", dockerArgs...)
	var stdoutBuf bytes.Buffer
	var stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	if err := cmd.Run(); err != nil {
		stderrStr := strings.TrimSpace(stderrBuf.String())
		slog.Error("Failed to read file from container",
			"workspace", workspaceID,
			"path", filePath,
			"error", err,
			"stderr", stderrStr,
		)
		writeError(w, http.StatusInternalServerError, "failed to read file")
		return
	}

	// Determine content type from file extension
	fileName := filepath.Base(filePath)
	// Strip CRLF from filename to prevent header injection
	fileName = strings.NewReplacer("\r", "", "\n", "").Replace(fileName)
	contentType := mime.TypeByExtension(filepath.Ext(fileName))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", fileName))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", stdoutBuf.Len()))
	w.WriteHeader(http.StatusOK)

	if _, err := io.Copy(w, &stdoutBuf); err != nil {
		slog.Error("Error writing download response",
			"workspace", workspaceID,
			"path", filePath,
			"error", err,
		)
	}
}
