package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func attachmentReferences(ctx context.Context, runtime Runtime, client APIClient, project string, p parsedArgs) ([]map[string]any, error) {
	maxUpload, err := workflowByteLimit(runtime, "SAM_CLI_MAX_UPLOAD_BYTES", 50<<20)
	if err != nil {
		return nil, err
	}
	maxRefs, err := workflowByteLimit(runtime, "SAM_CLI_MAX_ATTACHMENT_REFERENCE_BYTES", 1<<20)
	if err != nil {
		return nil, err
	}
	var refs []map[string]any
	if path := p.Flags["attachment-ref-file"]; path != "" {
		f, e := os.Open(path)
		if e != nil {
			return nil, e
		}
		defer f.Close()
		b, e := io.ReadAll(io.LimitReader(f, maxRefs+1))
		if e != nil {
			return nil, e
		}
		if int64(len(b)) > maxRefs {
			return nil, fmt.Errorf("attachment references exceed configured byte limit")
		}
		if e = json.Unmarshal(b, &refs); e != nil {
			return nil, fmt.Errorf("invalid attachment reference file")
		}
	}
	paths := p.MultiFlags["attachment"]
	// Validate every local file before creating an upload resource.
	for _, path := range paths {
		info, e := os.Stat(path)
		if e != nil {
			return nil, e
		}
		if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxUpload {
			return nil, fmt.Errorf("attachment must be a regular nonempty file within configured upload byte limit")
		}
	}
	for _, path := range paths {
		ref, e := uploadAttachment(ctx, runtime, client, project, path)
		if e != nil {
			return nil, e
		}
		refs = append(refs, ref)
	}
	return refs, nil
}
func uploadAttachment(ctx context.Context, runtime Runtime, client APIClient, project, path string) (map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	filename := filepath.Base(path)
	contentType := mime.TypeByExtension(filepath.Ext(filename))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	var upload map[string]any
	if err = client.request(ctx, http.MethodPost, projectAPIPath(project, "tasks", "request-upload"), map[string]any{"filename": filename, "size": info.Size(), "contentType": contentType}, &upload); err != nil {
		return nil, err
	}
	signed, _ := upload["uploadUrl"].(string)
	target, err := url.Parse(signed)
	if err != nil || target.Scheme != "https" || !strings.HasSuffix(target.Hostname(), ".r2.cloudflarestorage.com") || target.User != nil {
		return nil, fmt.Errorf("attachment API returned an unsupported upload origin")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, signed, f)
	if err != nil {
		return nil, err
	}
	req.ContentLength = info.Size()
	req.Header.Set("Content-Type", contentType)
	response, err := runtime.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("attachment upload transport failed; reconcile before retrying")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("attachment upload failed with status %d", response.StatusCode)
	}
	id, _ := upload["uploadId"].(string)
	if id == "" {
		return nil, fmt.Errorf("upload response missing reference ID")
	}
	return map[string]any{"uploadId": id, "filename": filename, "size": info.Size(), "contentType": contentType}, nil
}
