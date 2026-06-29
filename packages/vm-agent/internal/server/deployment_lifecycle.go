package server

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

func (s *Server) handleTeardownDeploymentEnvironment(w http.ResponseWriter, r *http.Request) {
	if !s.requireNodeManagementAuth(w, r, "") {
		return
	}
	if s.config == nil || s.config.Role != config.RoleDeployment {
		writeError(w, http.StatusConflict, "node is not a deployment node")
		return
	}

	environmentID := strings.TrimSpace(r.PathValue("environmentId"))
	if environmentID == "" {
		writeError(w, http.StatusBadRequest, "environmentId is required")
		return
	}

	engine := s.ensureDeployEngine(environmentID)
	if engine == nil {
		writeError(w, http.StatusInternalServerError, "deployment engine unavailable")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	if err := engine.Teardown(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	s.deployMu.Lock()
	if s.deployEngines[environmentID] == engine {
		delete(s.deployEngines, environmentID)
	}
	delete(s.deployRetiring, environmentID)
	s.deployMu.Unlock()

	writeJSON(w, http.StatusOK, map[string]string{
		"environmentId": environmentID,
		"status":        "torn_down",
	})
}
