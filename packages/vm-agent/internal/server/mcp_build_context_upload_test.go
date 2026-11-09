package server

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

type contextUploadBody struct {
	io.Reader
	bytes  int
	closed bool
}

func (b *contextUploadBody) Read(p []byte) (int, error) {
	n, err := b.Reader.Read(p)
	b.bytes += n
	return n, err
}
func (b *contextUploadBody) Close() error { b.closed = true; return nil }

func TestBuildContextUploadResponseSafeErrors(t *testing.T) {
	const sensitive = "SIGNED_URL_AND_WORKSPACE_TOKEN_MUST_NOT_APPEAR"
	for _, tc := range []struct{ name, body, code string }{
		{"signature", "<Error><Code>SignatureDoesNotMatch</Code><Message>" + sensitive + "</Message><CanonicalRequest>" + sensitive + "</CanonicalRequest></Error>", "SignatureDoesNotMatch"},
		{"credentials", "<Error><Code>InvalidAccessKeyId</Code><Message>" + sensitive + "</Message></Error>", "InvalidAccessKeyId"},
		{"unknown code", "<Error><Code>" + sensitive + "</Code></Error>", ""},
		{"malformed", sensitive, ""},
		{"oversized", "<Error><Message>" + strings.Repeat(sensitive, 1024) + "</Message><Code>AccessDenied</Code></Error>", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := &contextUploadBody{Reader: strings.NewReader(tc.body)}
			err := buildContextUploadResponse(&http.Response{StatusCode: 403, Body: body})
			if err == nil || !strings.Contains(err.Error(), "403") {
				t.Fatalf("missing status: %v", err)
			}
			if strings.Contains(err.Error(), sensitive) {
				t.Fatal("error body leaked")
			}
			if tc.code != "" && !strings.Contains(err.Error(), tc.code) {
				t.Fatalf("missing safe code: %v", err)
			}
			if !body.closed || body.bytes > DEFAULT_BUILD_CONTEXT_UPLOAD_RESPONSE_MAX_BYTES {
				t.Fatalf("unbounded/unclosed body: %+v", body)
			}
		})
	}
	body := &contextUploadBody{Reader: strings.NewReader(strings.Repeat(sensitive, 1024))}
	if err := buildContextUploadResponse(&http.Response{StatusCode: 200, Body: body}); err != nil {
		t.Fatal(err)
	}
	if !body.closed || body.bytes > DEFAULT_BUILD_CONTEXT_UPLOAD_RESPONSE_MAX_BYTES {
		t.Fatal("success body unbounded/unclosed")
	}
}
