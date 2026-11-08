package server

import (
	"crypto/subtle"
	"log/slog"
	"net/http"
	"strings"
)

// gitCredentialRejectGenerationMismatch is logged when a signature-valid
// workspace callback JWT belongs to another callback generation of the workspace.
const gitCredentialRejectGenerationMismatch = "generation_mismatch"

// isValidCallbackAuth authorizes a bearer on the local git-credential endpoint.
// An exact match with a token this agent holds is accepted. Otherwise a
// signature-valid workspace callback JWT is accepted only if it carries the same
// callback generation ("cgen") as the workspace's current token: the control
// plane rotates the generation when the workspace ID is reactivated, and a
// previous runtime's token must stop working here as it does at the control plane.
func (s *Server) isValidCallbackAuth(r *http.Request, workspaceID string) bool {
	given := bearerTokenFromHeader(r.Header.Get("Authorization"))
	if given == "" {
		slog.Warn("Git credential auth rejected: missing bearer token", "workspaceID", workspaceID)
		return false
	}

	candidates := s.callbackAuthCandidates(workspaceID)
	for _, candidate := range candidates {
		if constantTimeTokenEqual(given, candidate.token) {
			return true
		}
	}

	jwtErr := "not_checked"
	reason := "token_mismatch"
	if workspaceID != "" {
		if s.jwtValidator == nil {
			jwtErr = "validator_unavailable"
		} else if claims, err := s.jwtValidator.ValidateWorkspaceCallbackToken(given, workspaceID); err != nil {
			jwtErr = err.Error()
		} else if !s.isCurrentCallbackGeneration(workspaceID, claims.CallbackGeneration) {
			jwtErr = "valid"
			reason = gitCredentialRejectGenerationMismatch
		} else {
			return true
		}
	}

	s.logGitCredentialAuthRejected(workspaceID, len(given), candidates, jwtErr, reason)
	return false
}

// isCurrentCallbackGeneration reports whether presented equals the callback
// generation of the token this agent currently holds for the workspace (the
// runtime token, else the configured token, as callbackTokenForWorkspace
// resolves it). A current token without a decodable cgen claim has generation
// "": it then admits only tokens that also carry none, so a token from any
// rotated generation is refused when the agent cannot prove it is current.
func (s *Server) isCurrentCallbackGeneration(workspaceID, presented string) bool {
	current, _ := decodeCallbackTokenClaims(s.callbackTokenForWorkspace(workspaceID))
	return current.CallbackGeneration == presented
}

type callbackAuthCandidate struct {
	source string
	token  string
}

func (s *Server) callbackAuthCandidates(workspaceID string) []callbackAuthCandidate {
	candidates := []callbackAuthCandidate{{
		source: "config",
		token:  strings.TrimSpace(s.config.CallbackToken),
	}}
	if workspaceID == "" {
		return candidates
	}
	if token, ok := s.lookupWorkspaceCallbackToken(workspaceID); ok {
		candidates = append(candidates, callbackAuthCandidate{
			source: "workspace",
			token:  token,
		})
	}
	return candidates
}

func constantTimeTokenEqual(given, expected string) bool {
	if expected == "" || len(given) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(given), []byte(expected)) == 1
}

// logGitCredentialAuthRejected never logs token values or callback generations.
func (s *Server) logGitCredentialAuthRejected(
	workspaceID string,
	givenLen int,
	candidates []callbackAuthCandidate,
	jwtErr string,
	reason string,
) {
	sources := make([]string, 0, len(candidates))
	lengths := make([]int, 0, len(candidates))
	for _, candidate := range candidates {
		sources = append(sources, candidate.source)
		lengths = append(lengths, len(candidate.token))
	}
	_, runtimeExists := s.getWorkspaceRuntime(workspaceID)
	slog.Warn("Git credential auth rejected",
		"workspaceID", workspaceID,
		"reason", reason,
		"runtimeExists", runtimeExists,
		"givenLen", givenLen,
		"candidateSources", sources,
		"candidateLens", lengths,
		"jwtValidation", jwtErr,
	)
}
