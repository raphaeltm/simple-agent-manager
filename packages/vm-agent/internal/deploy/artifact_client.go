package deploy

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

const (
	defaultArtifactKeepAlive             = 30 * time.Second
	defaultArtifactMaxIdleConns          = 100
	defaultArtifactIdleConnTimeout       = 90 * time.Second
	defaultArtifactExpectContinueTimeout = 1 * time.Second
)

type ArtifactHTTPClientConfig struct {
	DialTimeout           time.Duration
	TLSHandshakeTimeout   time.Duration
	ResponseHeaderTimeout time.Duration
}

func NewArtifactHTTPClient(cfg ArtifactHTTPClientConfig) *http.Client {
	if cfg.DialTimeout <= 0 {
		cfg.DialTimeout = config.DefaultDeployArtifactDialTimeout
	}
	if cfg.TLSHandshakeTimeout <= 0 {
		cfg.TLSHandshakeTimeout = config.DefaultDeployArtifactTLSHandshakeTimeout
	}
	if cfg.ResponseHeaderTimeout <= 0 {
		cfg.ResponseHeaderTimeout = config.DefaultDeployArtifactResponseHeaderTimeout
	}
	return &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   cfg.DialTimeout,
				KeepAlive: defaultArtifactKeepAlive,
			}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          defaultArtifactMaxIdleConns,
			IdleConnTimeout:       defaultArtifactIdleConnTimeout,
			TLSHandshakeTimeout:   cfg.TLSHandshakeTimeout,
			ExpectContinueTimeout: defaultArtifactExpectContinueTimeout,
			ResponseHeaderTimeout: cfg.ResponseHeaderTimeout,
		},
	}
}

type idleProgressReader struct {
	ctx         context.Context
	cancel      context.CancelCauseFunc
	reader      io.Reader
	timer       *time.Timer
	idleTimeout time.Duration
	serviceName string
}

func newIdleProgressReader(ctx context.Context, cancel context.CancelCauseFunc, reader io.Reader, idleTimeout time.Duration, serviceName string) *idleProgressReader {
	r := &idleProgressReader{
		ctx:         ctx,
		cancel:      cancel,
		reader:      reader,
		idleTimeout: idleTimeout,
		serviceName: serviceName,
	}
	r.timer = time.AfterFunc(idleTimeout, func() {
		cancel(fmt.Errorf("artifact %s download stalled: no bytes read for %s", serviceName, idleTimeout))
	})
	return r
}

func (r *idleProgressReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	if n > 0 && r.timer != nil {
		r.timer.Reset(r.idleTimeout)
	}
	if err != nil && r.timer != nil {
		r.timer.Stop()
	}
	if err != nil && r.ctx.Err() != nil {
		if cause := context.Cause(r.ctx); cause != nil {
			return n, cause
		}
	}
	return n, err
}

func (r *idleProgressReader) Stop() {
	if r != nil && r.timer != nil {
		r.timer.Stop()
	}
}
