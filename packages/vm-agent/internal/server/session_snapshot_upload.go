package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"
)

type countingReader struct {
	r    io.Reader
	n    int64
	hash hashWriter
}

type hashWriter interface {
	Write([]byte) (int, error)
	Sum([]byte) []byte
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	if n > 0 {
		r.n += int64(n)
		_, _ = r.hash.Write(p[:n])
	}
	return n, err
}

func snapshotFileIdentity(filePath string) (int64, string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	fileInfo, err := file.Stat()
	if err != nil {
		return 0, "", err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return 0, "", err
	}
	return fileInfo.Size(), hex.EncodeToString(hash.Sum(nil)), nil
}

func checksumBase64(checksum string) (string, error) {
	bytes, err := hex.DecodeString(strings.TrimSpace(checksum))
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(bytes), nil
}

func (s *Server) uploadSessionSnapshotArtifact(ctx context.Context, legacyPath, directUploadPath, filePath, token string, idleTimeout time.Duration) (int64, string, error) {
	size, checksum, err := snapshotFileIdentity(filePath)
	if err != nil {
		return 0, "", err
	}
	if strings.TrimSpace(directUploadPath) != "" {
		uploadURL, authorizeErr := s.authorizeSessionSnapshotDirectUpload(ctx, directUploadPath, token, size, checksum, "", "")
		if authorizeErr != nil {
			return 0, "", authorizeErr
		}
		return s.uploadPreparedSnapshotFile(ctx, uploadURL, filePath, "", size, checksum, idleTimeout)
	}
	return s.uploadPreparedSnapshotFile(ctx, legacyPath, filePath, token, size, checksum, idleTimeout)
}

func (s *Server) authorizeSessionSnapshotDirectUpload(ctx context.Context, authorizationPath, token string, size int64, checksum, relayNodeID, relayToken string) (string, error) {
	payload, err := json.Marshal(map[string]interface{}{
		"sizeBytes":      size,
		"sha256":         checksum,
		"checksumHeader": true,
	})
	if err != nil {
		return "", err
	}
	target := absoluteControlPlaneURL(s.config.ControlPlaneURL, authorizationPath)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	if relayNodeID != "" || relayToken != "" {
		req.Header.Set("X-SAM-Relay-Node-ID", relayNodeID)
		req.Header.Set("X-SAM-Relay-Authorization", "Bearer "+relayToken)
	}
	res, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1024*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("direct artifact upload authorization failed HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	var response struct {
		UploadURL string `json:"uploadUrl"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return "", err
	}
	if strings.TrimSpace(response.UploadURL) == "" {
		return "", fmt.Errorf("direct artifact upload authorization returned no URL")
	}
	return response.UploadURL, nil
}

func (s *Server) uploadSnapshotFile(ctx context.Context, uploadPath, filePath, token string, idleTimeout time.Duration) (int64, string, error) {
	size, checksum, err := snapshotFileIdentity(filePath)
	if err != nil {
		return 0, "", err
	}
	return s.uploadPreparedSnapshotFile(ctx, uploadPath, filePath, token, size, checksum, idleTimeout)
}

func (s *Server) uploadPreparedSnapshotFile(ctx context.Context, uploadPath, filePath, token string, size int64, checksum string, idleTimeout time.Duration) (int64, string, error) {
	target := absoluteControlPlaneURL(s.config.ControlPlaneURL, uploadPath)
	file, err := os.Open(filePath)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	uploadHash := sha256.New()
	reader := &countingReader{r: file, hash: uploadHash}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, target, newIdleReader(reader, idleTimeout))
	if err != nil {
		return 0, "", err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-SAM-Content-SHA256", checksum)
	}
	if checksumHeader, checksumErr := checksumBase64(checksum); checksumErr == nil {
		req.Header.Set("x-amz-checksum-sha256", checksumHeader)
	}
	req.ContentLength = size
	res, err := s.controlPlaneHTTPClient(s.sessionSnapshotOperationTimeout()).Do(req)
	if err != nil {
		return 0, "", err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return 0, "", fmt.Errorf("artifact upload failed HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	uploadSHA := hex.EncodeToString(uploadHash.Sum(nil))
	if reader.n != size || uploadSHA != checksum {
		return 0, "", fmt.Errorf("snapshot artifact changed during upload")
	}
	return reader.n, checksum, nil
}

func validateSnapshotRelayAuthorizationPath(raw string) (string, error) {
	parsed, err := url.ParseRequestURI(strings.TrimSpace(raw))
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("invalid snapshot authorization path")
	}
	if parsed.RawPath != "" || path.Clean(parsed.Path) != parsed.Path {
		return "", fmt.Errorf("invalid snapshot authorization path")
	}
	segments := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
	if len(segments) != 7 ||
		segments[0] != "api" ||
		segments[1] != "workspaces" ||
		segments[2] == "" ||
		segments[3] != "session-snapshot" ||
		segments[4] != "artifacts" ||
		(segments[5] != "home" && segments[5] != "wip") ||
		segments[6] != "upload-url" {
		return "", fmt.Errorf("invalid snapshot authorization path")
	}
	query := parsed.Query()
	if len(query) != 2 || len(query["chatSessionId"]) != 1 || len(query["generation"]) != 1 ||
		strings.TrimSpace(query.Get("chatSessionId")) == "" || strings.TrimSpace(query.Get("generation")) == "" {
		return "", fmt.Errorf("invalid snapshot authorization query")
	}
	return parsed.String(), nil
}

// handleSessionSnapshotUploadRelay lets a current VM agent stream an artifact
// from a busy legacy node to a checksum-bound R2 URL. The legacy workspace
// bearer is validated by the control plane before this handler reads the body,
// and it is deliberately omitted from the R2 request.
func (s *Server) handleSessionSnapshotUploadRelay(w http.ResponseWriter, r *http.Request) {
	// The server's normal HTTP_READ_TIMEOUT is deliberately short for API calls,
	// but a snapshot can be hundreds of MiB. Override that connection deadline
	// for this bounded transfer so the relay has the same configurable window as
	// capture and direct upload. ResponseRecorder and other wrappers may not
	// expose deadlines, so unsupported controllers remain harmless in tests.
	_ = http.NewResponseController(w).SetReadDeadline(
		time.Now().Add(s.sessionSnapshotOperationTimeout()),
	)
	authorizationPath, err := validateSnapshotRelayAuthorizationPath(r.URL.Query().Get("authorizationPath"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(authHeader, "Bearer ") || strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer ")) == "" {
		writeError(w, http.StatusUnauthorized, "missing bearer token")
		return
	}
	if r.ContentLength < 0 {
		writeError(w, http.StatusLengthRequired, "Content-Length is required")
		return
	}
	checksum := strings.ToLower(strings.TrimSpace(r.Header.Get("X-SAM-Content-SHA256")))
	if len(checksum) != sha256.Size*2 {
		writeError(w, http.StatusBadRequest, "valid snapshot SHA-256 is required")
		return
	}
	if _, err := hex.DecodeString(checksum); err != nil {
		writeError(w, http.StatusBadRequest, "valid snapshot SHA-256 is required")
		return
	}
	token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	uploadURL, err := s.authorizeSessionSnapshotDirectUpload(
		r.Context(),
		authorizationPath,
		token,
		r.ContentLength,
		checksum,
		s.config.NodeID,
		s.getCallbackToken(),
	)
	if err != nil {
		writeError(w, http.StatusForbidden, "snapshot upload authorization failed")
		return
	}

	uploadRequest, err := http.NewRequestWithContext(r.Context(), http.MethodPut, uploadURL, r.Body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create snapshot upload")
		return
	}
	if checksumHeader, checksumErr := checksumBase64(checksum); checksumErr == nil {
		uploadRequest.Header.Set("x-amz-checksum-sha256", checksumHeader)
	}
	uploadRequest.ContentLength = r.ContentLength
	response, err := s.controlPlaneHTTPClient(s.sessionSnapshotOperationTimeout()).Do(uploadRequest)
	if err != nil {
		writeError(w, http.StatusBadGateway, "snapshot storage upload failed")
		return
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("snapshot storage upload failed HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(responseBody))))
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"uploaded": true})
}
