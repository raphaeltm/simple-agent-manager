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

	s.deployMu.Lock()
	engine := s.deployEngines[environmentID]
	s.deployMu.Unlock()
	if engine == nil {
		writeError(w, http.StatusNotFound, "deployment environment is not active on this node")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.deployTeardownTimeout())
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

func (s *Server) deployTeardownTimeout() time.Duration {
	if s.config != nil && s.config.DeployTeardownTimeout > 0 {
		return s.config.DeployTeardownTimeout
	}
	return config.DefaultDeployTeardownTimeout
}
