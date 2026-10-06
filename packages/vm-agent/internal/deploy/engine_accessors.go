package deploy

// SetCallbackToken updates the callback token for control plane requests.
// Safe to call concurrently with fetchRelease (heartbeat vs apply goroutine).
func (e *Engine) SetCallbackToken(token string) {
	e.tokenMu.Lock()
	defer e.tokenMu.Unlock()
	e.callbackToken = token
}

func (e *Engine) EnvironmentID() string {
	return e.cfg.EnvironmentID
}

// getCallbackToken returns the current callback token under a read lock.
func (e *Engine) getCallbackToken() string {
	e.tokenMu.RLock()
	defer e.tokenMu.RUnlock()
	return e.callbackToken
}

// SetVerifierKey updates the signing public key via the verifier's dual-key rotation.
func (e *Engine) SetVerifierKey(pubKeyB64 string) error {
	e.verifierMu.Lock()
	defer e.verifierMu.Unlock()

	if e.verifier == nil {
		verifier, err := NewVerifier(pubKeyB64)
		if err != nil {
			return err
		}
		e.verifier = verifier
		return nil
	}
	return e.verifier.SetCurrentKey(pubKeyB64)
}
