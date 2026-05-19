package cli

import (
	"context"
	"errors"
	"strings"
)

const (
	dockerBinary          = "docker"
	dockerDaemonCheckName = "Docker daemon"
	systemdCheckName      = "systemd"
	vmAgentBinary         = "vm-agent"
)

type RunnerDoctorReport struct {
	OS     string              `json:"os"`
	Arch   string              `json:"arch"`
	Checks []RunnerDoctorCheck `json:"checks"`
	Ready  bool                `json:"ready"`
}

type RunnerDoctorCheck struct {
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Detail  string `json:"detail"`
	Warning bool   `json:"warning,omitempty"`
}

func RunRunnerDoctor(ctx context.Context, runner Runner) RunnerDoctorReport {
	report := RunnerDoctorReport{
		OS:    runner.GOOS(),
		Arch:  runner.GOARCH(),
		Ready: true,
	}
	report.add(checkLookPath(runner, dockerBinary, "Docker CLI"))
	report.add(checkDockerDaemon(ctx, runner))
	report.add(checkSystemd(ctx, runner))
	report.add(checkVMDAgent(runner))
	return report
}

func (r *RunnerDoctorReport) add(check RunnerDoctorCheck) {
	r.Checks = append(r.Checks, check)
	if !check.OK && !check.Warning {
		r.Ready = false
	}
}

func checkLookPath(runner Runner, binary string, label string) RunnerDoctorCheck {
	path, err := runner.LookPath(binary)
	if err != nil {
		return RunnerDoctorCheck{Name: label, OK: false, Detail: binary + " not found on PATH"}
	}
	return RunnerDoctorCheck{Name: label, OK: true, Detail: path}
}

func checkDockerDaemon(ctx context.Context, runner Runner) RunnerDoctorCheck {
	if _, err := runner.LookPath(dockerBinary); err != nil {
		return RunnerDoctorCheck{Name: dockerDaemonCheckName, OK: false, Detail: "docker CLI is not installed"}
	}
	output, err := runner.Command(ctx, dockerBinary, "version", "--format", "{{.Server.Version}}")
	if err != nil {
		return RunnerDoctorCheck{Name: dockerDaemonCheckName, OK: false, Detail: strings.TrimSpace(string(output))}
	}
	return RunnerDoctorCheck{Name: dockerDaemonCheckName, OK: true, Detail: strings.TrimSpace(string(output))}
}

func checkSystemd(ctx context.Context, runner Runner) RunnerDoctorCheck {
	if runner.GOOS() != "linux" {
		return RunnerDoctorCheck{Name: systemdCheckName, OK: false, Warning: true, Detail: "systemd is only expected on Linux hosts"}
	}
	if _, err := runner.LookPath("systemctl"); err != nil {
		return RunnerDoctorCheck{Name: systemdCheckName, OK: false, Detail: "systemctl not found"}
	}
	output, err := runner.Command(ctx, "systemctl", "is-system-running")
	detail := strings.TrimSpace(string(output))
	if err != nil && !errors.Is(err, context.Canceled) {
		if detail == "" {
			detail = err.Error()
		}
		return RunnerDoctorCheck{Name: systemdCheckName, OK: false, Detail: detail}
	}
	if detail == "" {
		detail = "available"
	}
	return RunnerDoctorCheck{Name: systemdCheckName, OK: true, Detail: detail}
}

func checkVMDAgent(runner Runner) RunnerDoctorCheck {
	path, err := runner.LookPath(vmAgentBinary)
	if err != nil {
		return RunnerDoctorCheck{Name: vmAgentBinary, OK: false, Warning: true, Detail: "vm-agent is not installed yet"}
	}
	return RunnerDoctorCheck{Name: vmAgentBinary, OK: true, Detail: path}
}

func FormatRunnerDoctor(report RunnerDoctorReport) string {
	var builder strings.Builder
	builder.WriteString("SAM runner doctor\n")
	builder.WriteString("os: " + report.OS + "\n")
	builder.WriteString("arch: " + report.Arch + "\n")
	for _, check := range report.Checks {
		status := "ok"
		if !check.OK && check.Warning {
			status = "warning"
		} else if !check.OK {
			status = "failed"
		}
		builder.WriteString("- " + check.Name + ": " + status)
		if check.Detail != "" {
			builder.WriteString(" (" + check.Detail + ")")
		}
		builder.WriteString("\n")
	}
	return strings.TrimRight(builder.String(), "\n")
}
