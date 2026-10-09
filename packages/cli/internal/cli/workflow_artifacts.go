package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
)

func runArtifactDownload(ctx context.Context, runtime Runtime, p parsedArgs, args []string) int {
	family := p.Positionals[0]
	if family == "library" && len(args) != 1 || family == "files" && len(args) != 0 {
		return fail(runtime.Stderr, fmt.Errorf("invalid download arguments"))
	}
	output := p.Flags["output"]
	if output == "" {
		return fail(runtime.Stderr, fmt.Errorf("download requires --output; private bytes are not printed to diagnostics"))
	}
	maxBytes, err := workflowByteLimit(runtime, "SAM_CLI_MAX_DOWNLOAD_BYTES", 64<<20)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	project, _, err := resolveProjectRef(ctx, client, p, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	path := ""
	if family == "library" {
		path = projectAPIPath(project, "library", args[0], "download")
	} else {
		if p.Flags["ref"] == "" || p.Flags["path"] == "" {
			return fail(runtime.Stderr, fmt.Errorf("files download requires --ref and --path"))
		}
		path = projectAPIPath(project, "repo", "raw") + "?" + url.Values{"ref": {p.Flags["ref"]}, "path": {p.Flags["path"]}}.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, client.config.APIURL+path, nil)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	req.Header.Set("Cookie", client.config.SessionCookie)
	response, err := runtime.HTTPClient.Do(req)
	if err != nil {
		return fail(runtime.Stderr, fmt.Errorf("artifact download transport failed"))
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fail(runtime.Stderr, APIError{Status: response.StatusCode, Code: "DOWNLOAD_FAILED", Message: "Artifact download rejected"})
	}
	f, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	written, err := io.Copy(f, io.LimitReader(response.Body, maxBytes+1))
	closeErr := f.Close()
	if err != nil || closeErr != nil || written > maxBytes {
		_ = os.Remove(output)
		return fail(runtime.Stderr, fmt.Errorf("artifact download incomplete or exceeds configured download byte limit"))
	}
	return writeWorkflow(runtime, p, map[string]any{"output": output, "bytes": written, "complete": true})
}
