package builder

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/klauspost/compress/zstd"
)

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

// Download verifies both declared bytes and the digest before any extraction.
// Signed URLs are never included in returned errors, including redirect errors.
func Download(ctx context.Context, client *http.Client, url string, size int64, digest string, max int64, output *os.File) error {
	if size <= 0 || size > max || len(digest) != 64 {
		return errors.New("invalid context descriptor")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return errors.New("invalid context download URL")
	}
	response, err := client.Do(req)
	if err != nil {
		return errors.New("context download failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("context download returned %d", response.StatusCode)
	}
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(output, hash), io.LimitReader(response.Body, size+1))
	if err != nil {
		return errors.New("context download interrupted")
	}
	if n != size || hex.EncodeToString(hash.Sum(nil)) != digest {
		return errors.New("context size or sha256 mismatch")
	}
	_, err = output.Seek(0, io.SeekStart)
	return err
}

// Extract uses one directory capability, refuses special files and links out of
// the root, and bounds decompressed tar bytes (headers and payload). No guest
// command runs until extraction has completed.
func Extract(ctx context.Context, input io.Reader, destination string, max int64) error {
	decoder, err := zstd.NewReader(input, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(uint64(max)))
	if err != nil {
		return err
	}
	defer decoder.Close()
	limited := &io.LimitedReader{R: contextReader{ctx, decoder}, N: max + 1}
	reader := tar.NewReader(limited)
	root, err := os.OpenRoot(destination)
	if err != nil {
		return err
	}
	defer root.Close()
	for {
		header, err := reader.Next()
		if err == io.EOF {
			if limited.N <= 1 {
				return errors.New("expanded context exceeds maximum bytes")
			}
			return nil
		}
		if err != nil {
			return errors.New("invalid or oversized context archive")
		}
		name := path.Clean(header.Name)
		if name == "." || !safeRelative(name) || strings.Contains(header.Name, "\\") {
			return errors.New("unsafe archive path")
		}
		if header.Size < 0 || header.Size > max || limited.N-header.Size <= 0 {
			return errors.New("expanded context exceeds maximum bytes")
		}
		if err = root.MkdirAll(path.Dir(name), 0700); err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err = root.MkdirAll(name, 0700); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			file, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(header.Mode)&0777)
			if err != nil {
				return errors.New("duplicate or unsafe archive entry")
			}
			_, copyErr := io.CopyN(file, reader, header.Size)
			closeErr := file.Close()
			if copyErr != nil {
				return errors.New("truncated archive entry")
			}
			if closeErr != nil {
				return closeErr
			}
		case tar.TypeSymlink:
			if !safeRelative(path.Join(path.Dir(name), header.Linkname)) || path.IsAbs(header.Linkname) || strings.Contains(header.Linkname, "\\") {
				return errors.New("unsafe archive symlink")
			}
			if err = root.Symlink(header.Linkname, name); err != nil {
				return err
			}
		default:
			return errors.New("unsupported archive entry type")
		}
	}
}
func safeRelative(name string) bool {
	return name != "" && !path.IsAbs(name) && name != ".." && !strings.HasPrefix(name, "../")
}
