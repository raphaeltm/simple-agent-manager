package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
)

func runLibraryUpload(ctx context.Context, runtime Runtime, p parsedArgs, args []string) int {
	if len(args) != 1 {
		return fail(runtime.Stderr, fmt.Errorf("library upload requires one local file"))
	}
	maxUpload, err := workflowByteLimit(runtime, "SAM_CLI_MAX_UPLOAD_BYTES", 50<<20)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	file, err := os.Open(args[0])
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > maxUpload {
		return fail(runtime.Stderr, fmt.Errorf("library upload requires a regular nonempty file within configured upload byte limit"))
	}
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	project, _, err := resolveProjectRef(ctx, client, p, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", filepath.Base(args[0]))
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if _, err = io.Copy(part, io.LimitReader(file, maxUpload+1)); err != nil {
		return fail(runtime.Stderr, err)
	}
	for _, name := range []string{"directory", "description", "filename", "mimeType"} {
		if value := p.Flags[name]; value != "" {
			if err = form.WriteField(name, value); err != nil {
				return fail(runtime.Stderr, err)
			}
		}
	}
	if err = form.Close(); err != nil {
		return fail(runtime.Stderr, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, client.config.APIURL+projectAPIPath(project, "library", "upload"), &body)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	req.Header.Set("Cookie", client.config.SessionCookie)
	req.Header.Set("Content-Type", form.FormDataContentType())
	response, err := runtime.HTTPClient.Do(req)
	if err != nil {
		return fail(runtime.Stderr, APIError{Code: "OUTCOME_UNKNOWN", Message: "Upload outcome unknown; inspect Library before retrying"})
	}
	defer response.Body.Close()
	content, truncated, err := readBoundedAPIResponseBody(response.Body, client.config.maxAPIResponseBytes())
	if err != nil || truncated {
		return fail(runtime.Stderr, fmt.Errorf("upload response incomplete; inspect Library before retrying"))
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fail(runtime.Stderr, parseAPIError(response.StatusCode, content))
	}
	var value any
	if err = json.Unmarshal(content, &value); err != nil {
		return fail(runtime.Stderr, fmt.Errorf("upload accepted but receipt invalid; inspect Library before retrying"))
	}
	return writeWorkflow(runtime, p, value)
}
