package messagereport

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

type uploadPart struct {
	Action    string `json:"action"`
	SessionID string `json:"sessionId"`
	MessageID string `json:"messageId"`
	Field     string `json:"field"`
	Part      int    `json:"part"`
	Data      string `json:"data"`
}

type uploadCommit struct {
	Action         string  `json:"action"`
	SessionID      string  `json:"sessionId"`
	MessageID      string  `json:"messageId"`
	Role           string  `json:"role"`
	Timestamp      string  `json:"timestamp"`
	Origin         *string `json:"origin"`
	Sequence       int64   `json:"sequence"`
	ContentParts   int     `json:"contentParts"`
	MetadataParts  int     `json:"metadataParts"`
	ContentSHA256  string  `json:"contentSha256"`
	MetadataSHA256 string  `json:"metadataSha256"`
}

func uploadDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func splitUploadField(value string, maxBytes int) ([]string, error) {
	if value == "" {
		return nil, nil
	}
	if maxBytes < utf8.UTFMax || !utf8.ValidString(value) {
		return nil, fmt.Errorf("messagereport: invalid upload field or byte budget")
	}
	var parts []string
	for len(value) > 0 {
		end := min(len(value), maxBytes)
		for end < len(value) && end > 0 && !utf8.RuneStart(value[end]) {
			end--
		}
		if end == 0 {
			return nil, fmt.Errorf("messagereport: upload chunk split a rune")
		}
		parts = append(parts, value[:end])
		value = value[end:]
	}
	return parts, nil
}

func (r *Reporter) sendLargeMessage(row outboxRow, token, workspaceID string) error {
	defaults := DefaultConfig()
	maxUploadBytes := min(r.cfg.MaxMessageUploadBytes, defaults.MaxMessageUploadBytes)
	if len(row.content)+len(row.toolMetadata.String) > maxUploadBytes {
		return fmt.Errorf("messagereport: message %s exceeds logical upload limit", row.messageID)
	}
	maxBodyBytes := min(r.cfg.BatchMaxBytes, defaults.BatchMaxBytes)
	maxContentBytes := min(r.cfg.MaxMessageContentBytes, defaults.MaxMessageContentBytes)
	// Six JSON bytes per input byte covers control-character and HTML escaping.
	// Every actual serialized body is checked again before transmission.
	chunkBytes := min(maxContentBytes, (maxBodyBytes-2048)/6)
	contentParts, err := splitUploadField(row.content, chunkBytes)
	if err != nil {
		return err
	}
	metadataParts, err := splitUploadField(row.toolMetadata.String, chunkBytes)
	if err != nil {
		return err
	}
	maxParts := min(r.cfg.MaxMessageUploadParts, defaults.MaxMessageUploadParts)
	if len(contentParts) == 0 || len(contentParts) > maxParts || len(metadataParts) > maxParts {
		return fmt.Errorf("messagereport: message %s has invalid upload part count", row.messageID)
	}
	url := strings.TrimRight(r.cfg.Endpoint, "/") + "/api/workspaces/" + workspaceID + "/messages/upload"
	ctx, cancel := r.contextUntilStop()
	defer cancel()
	for _, field := range []struct {
		name  string
		parts []string
	}{
		{"content", contentParts}, {"toolMetadata", metadataParts},
	} {
		for index, data := range field.parts {
			body, err := json.Marshal(uploadPart{"part", row.sessionID, row.messageID, field.name, index, data})
			if err != nil {
				return err
			}
			if err := r.postUploadStep(ctx, url, token, body, "part"); err != nil {
				return err
			}
		}
	}
	var origin *string
	if row.origin.Valid {
		origin = &row.origin.String
	}
	body, err := json.Marshal(uploadCommit{
		Action: "commit", SessionID: row.sessionID, MessageID: row.messageID,
		Role: row.role, Timestamp: row.createdAt, Origin: origin, Sequence: row.id,
		ContentParts: len(contentParts), MetadataParts: len(metadataParts),
		ContentSHA256: uploadDigest(row.content), MetadataSHA256: uploadDigest(row.toolMetadata.String),
	})
	if err != nil {
		return err
	}
	return r.postUploadStep(ctx, url, token, body, "commit")
}

func (r *Reporter) postUploadStep(ctx context.Context, url, token string, body []byte, action string) error {
	maxBodyBytes := min(r.cfg.BatchMaxBytes, DefaultConfig().BatchMaxBytes)
	if len(body) > maxBodyBytes {
		return fmt.Errorf("messagereport: serialized upload step exceeds %d bytes", maxBodyBytes)
	}
	start := time.Now()
	delay := r.cfg.RetryInitial
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		status, response, err := r.doPostWithContext(ctx, url, token, body)
		if err == nil && status >= 200 && status < 300 {
			var ack struct {
				Accepted   bool `json:"accepted"`
				Persisted  int  `json:"persisted"`
				Duplicates int  `json:"duplicates"`
			}
			if status != http.StatusOK || json.Unmarshal([]byte(response), &ack) != nil ||
				(action == "part" && !ack.Accepted) ||
				(action == "commit" && ack.Persisted+ack.Duplicates != 1) {
				return fmt.Errorf("messagereport: upload %s was not acknowledged as stored (status=%d)", action, status)
			}
			return nil
		}
		if status == http.StatusConflict && isSessionMessageLimitError(response) {
			r.markMessageLimitReached(nil, response)
			return sessionMessageLimitError{responseBody: response}
		}
		if status >= 400 && status < 500 {
			return fmt.Errorf("messagereport: upload rejected status=%d body=%s", status, response)
		}
		if time.Since(start) >= r.cfg.RetryMaxElapsed {
			return fmt.Errorf("messagereport: upload retries exhausted status=%d err=%v", status, err)
		}
		if err := r.waitForRetry(delay, status, err); err != nil {
			return err
		}
		delay = r.nextRetryDelay(delay)
	}
}
