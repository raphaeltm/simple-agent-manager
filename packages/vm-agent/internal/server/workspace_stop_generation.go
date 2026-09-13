package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// Bodyless requests retain compatibility with legacy runtimes and standalone
// cleanup clients. VM lifecycle requests carry the observed runtime generation.
func decodeWorkspaceStopGeneration(w http.ResponseWriter, r *http.Request) (*string, bool) {
	var body struct {
		ExpectedEvictionGeneration *string `json:"expectedEvictionGeneration"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	err := decoder.Decode(&body)
	if errors.Is(err, io.EOF) {
		return nil, true
	}
	if err != nil || body.ExpectedEvictionGeneration == nil {
		writeError(w, http.StatusBadRequest, "invalid workspace stop request")
		return nil, false
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid workspace stop request")
		return nil, false
	}
	return body.ExpectedEvictionGeneration, true
}
