package messagereport

import (
	"errors"
	"log/slog"
	"time"
)

// A 401 from the messages endpoint means the control plane rejected the
// workspace callback token, not that the session or workspace is gone (those are
// 204/403/404/410). The token can still be replaced: the VM agent renews it
// before it expires, and the control plane re-delivers one on hibernate. So a
// 401 never deletes the outbox. Instead the reporter:
//
//   - resends at once when a renewal replaced the token while the request was in
//     flight (the 401 was for a token that is no longer current);
//   - otherwise sends nothing while the rejected token is still current, keeps
//     the queued rows (bounded by OutboxMaxSize), and resumes as soon as SetToken
//     installs a different token;
//   - surfaces a pause that outlasts AuthRenewalWait once, through an error log
//     and OnAuthRenewalWaitExceeded.
//
// The control plane authenticates before it reads the body and dedupes messages
// by id, so a held row that is resent can never be persisted twice.
//
// Held rows exist only in this VM's outbox. They are NOT durable transcript until
// delivered: a teardown while delivery is paused loses them.

var (
	errAwaitingCredential = errors.New("messagereport: holding messages until the workspace callback token is replaced")
	errCredentialRotated  = errors.New("messagereport: workspace callback token was replaced during the request")
)

// maxRotatedTokenRetriesPerFlush bounds immediate resends after a rotation, so
// a flush cannot spin if tokens keep changing under it.
const maxRotatedTokenRetriesPerFlush = 3

// credentialWait is the paused-delivery state. Guarded by Reporter.mu.
type credentialWait struct {
	rejectedToken string
	since         time.Time
	reported      bool
}

// resumeWith ends the pause when token differs from the rejected one.
func (w *credentialWait) resumeWith(token string) bool {
	if w.rejectedToken == "" || token == "" || token == w.rejectedToken {
		return false
	}
	*w = credentialWait{}
	return true
}

// AuthRenewalWaitExceeded describes a delivery pause that outlasted
// Config.AuthRenewalWait.
type AuthRenewalWaitExceeded struct {
	WorkspaceID  string
	SessionID    string
	HeldMessages int
	PausedFor    time.Duration
}

// credentialRejectedError is a 401 seen while sending one row on its own.
type credentialRejectedError struct {
	responseBody string
}

func (e credentialRejectedError) Error() string {
	return "workspace callback token rejected: " + e.responseBody
}

// credentialRejected handles a 401 for token. It returns errCredentialRotated
// when a renewal already replaced token (resend now), else pauses delivery and
// returns errAwaitingCredential.
func (r *Reporter) credentialRejected(token, responseBody string) error {
	r.mu.Lock()
	if r.authToken != token {
		r.mu.Unlock()
		return errCredentialRotated
	}
	first := r.credentialWait.rejectedToken != token
	if first {
		r.credentialWait = credentialWait{rejectedToken: token, since: r.now()}
	}
	wsID, sessionID := r.workspaceID, r.sessionID
	r.mu.Unlock()
	if first {
		slog.Warn("messagereport: control plane rejected the workspace callback token; holding messages until it is replaced",
			"workspaceId", wsID,
			"sessionId", sessionID,
			"responseBody", responseBody,
		)
	}
	return errAwaitingCredential
}

// awaitingCredential reports whether delivery is paused on token, and surfaces
// the pause once when it has lasted AuthRenewalWait.
func (r *Reporter) awaitingCredential(token string) bool {
	r.mu.Lock()
	if r.credentialWait.rejectedToken == "" || r.credentialWait.rejectedToken != token {
		r.mu.Unlock()
		return false
	}
	pausedFor := r.now().Sub(r.credentialWait.since)
	report := !r.credentialWait.reported && pausedFor >= r.cfg.AuthRenewalWait
	if report {
		r.credentialWait.reported = true
	}
	wsID, sessionID := r.workspaceID, r.sessionID
	r.mu.Unlock()
	if report {
		r.reportAuthRenewalWaitExceeded(AuthRenewalWaitExceeded{
			WorkspaceID:  wsID,
			SessionID:    sessionID,
			HeldMessages: r.heldMessageCount(),
			PausedFor:    pausedFor,
		})
	}
	return true
}

func (r *Reporter) reportAuthRenewalWaitExceeded(info AuthRenewalWaitExceeded) {
	slog.Error("messagereport: message persistence paused; the rejected workspace callback token has not been replaced",
		"workspaceId", info.WorkspaceID,
		"sessionId", info.SessionID,
		"heldMessages", info.HeldMessages,
		"pausedFor", info.PausedFor.String(),
	)
	if r.cfg.OnAuthRenewalWaitExceeded != nil {
		r.cfg.OnAuthRenewalWaitExceeded(info)
	}
}

// heldMessageCount is a bounded count of queued rows, or -1 if it cannot be read.
func (r *Reporter) heldMessageCount() int {
	var count int
	if err := r.db.QueryRow(
		"SELECT COUNT(*) FROM (SELECT 1 FROM message_outbox LIMIT ?)",
		r.cfg.OutboxMaxSize+1,
	).Scan(&count); err != nil {
		return -1
	}
	return count
}
