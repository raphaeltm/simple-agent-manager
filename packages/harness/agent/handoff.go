package agent

import (
	"context"
	"time"

	"github.com/workspace/harness/handoff"
	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/transcript"
)

const handoffTimeout = 30 * time.Second

func emitHandoff(ctx context.Context, provider llm.Provider, log *transcript.Log, cfg Config, userPrompt string, result *Result) *Result {
	if result == nil || !cfg.HandoffEnabled {
		return result
	}

	handoffCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), handoffTimeout)
	defer cancel()

	packet := handoff.Generate(handoffCtx, provider, handoff.Input{
		MissionID:      cfg.HandoffMissionID,
		FromTaskID:     cfg.HandoffFromTaskID,
		ToTaskID:       cfg.HandoffToTaskID,
		SessionID:      cfg.SessionID,
		TaskPrompt:     userPrompt,
		TerminalStatus: terminalStatus(result.StopReason),
		StopReason:     result.StopReason,
		TurnsUsed:      result.TurnsUsed,
		Messages:       result.Messages,
		Transcript:     log,
		TranscriptPath: cfg.HandoffTranscriptPath,
		WorkDir:        cfg.WorkDir,
	})
	result.Handoff = &packet
	return result
}

func terminalStatus(stopReason string) handoff.TerminalStatus {
	switch stopReason {
	case "complete":
		return handoff.StatusSuccess
	case "error":
		return handoff.StatusError
	default:
		return handoff.StatusIncomplete
	}
}
