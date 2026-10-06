package acp

import (
	"io"
	"syscall"
	"time"
)

type agentProcess interface {
	Stdin() io.Writer
	Stdout() io.Reader
	Stderr() io.Reader
	Stop() error
	Wait() error
	StartedAt() time.Time
	KillContainerProcesses(syscall.Signal)
	SetRecoveryNotify(recoveryNotify)
	RecoveryNotify() recoveryNotify
}

func (p *AgentProcess) StartedAt() time.Time {
	return p.startTime
}

func (p *AgentProcess) KillContainerProcesses(sig syscall.Signal) {
	p.killContainerProcesses(sig)
}

func (p *AgentProcess) SetRecoveryNotify(notify recoveryNotify) {
	p.recoveryMu.Lock()
	defer p.recoveryMu.Unlock()
	p.recoveryNotify = notify
}

func (p *AgentProcess) RecoveryNotify() recoveryNotify {
	p.recoveryMu.Lock()
	defer p.recoveryMu.Unlock()
	return p.recoveryNotify
}
