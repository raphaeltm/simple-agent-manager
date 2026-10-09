package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const submitFlagNames = "prompt prompt-file prompt-stdin agent agent-profile agent-profile-id skill context-summary devcontainer-config devcontainer-config-name mode node node-id parent-task parent-task-id provider min-vcpu min-memory-gb min-disk-gb exclusive-node vm-location vm-size workspace workspace-profile model max-co-tenants idempotency-key attachment"

func commandFlags(p parsedArgs) []string {
	c, _, ok := findWorkflow(p)
	if ok {
		if c.command == "library list" {
			c.query = append(c.query, "recursive", "all")
		}
		return append(append([]string(nil), c.query...), "all-pages")
	}
	if len(p.Positionals) == 0 {
		return nil
	}
	switch p.Positionals[0] {
	case "auth":
		return strings.Fields("api-url token session-cookie session-cookie-stdin")
	case "chat":
		if len(p.Positionals) > 1 && p.Positionals[1] == "new" {
			return strings.Fields(submitFlagNames)
		}
		if len(p.Positionals) > 1 && (p.Positionals[1] == "fork" || p.Positionals[1] == "retry") {
			return strings.Fields(submitFlagNames + " launch")
		}
		return strings.Fields("limit before after offset scope status compact order roles all-pages output ndjson hydrate-tools content content-file content-stdin idempotency-key answer")
	case "task", "tasks":
		return strings.Fields(submitFlagNames + " title description priority status limit cursor interval timeout")
	case "settings":
		if len(p.Positionals) > 1 && p.Positionals[1] == "update" {
			return strings.Fields("name description preview")
		}
		return nil
	case "project":
		return nil
	case "profiles", "skills":
		return strings.Fields("name description source preview expected-updated-at")
	case "ideas":
		return strings.Fields("title description priority preview")
	case "projects":
		return strings.Fields("limit cursor all-pages")
	case "workspace":
		return strings.Fields("port local-port local-host")
	case "library":
		return strings.Fields("recursive all limit cursor directory search output")
	default:
		return nil
	}
}
func validateCommandFlags(p parsedArgs) error {
	allowed := map[string]bool{}
	for _, s := range commandFlags(p) {
		allowed[s] = true
	}
	for _, f := range p.FlagOccurrences {
		if !allowed[f.Name] {
			return fmt.Errorf("unknown flag --%s for %s", f.Name, strings.Join(p.Positionals, " "))
		}
		if !f.HasValue && !booleanCommandFlag(f.Name) && !strings.HasPrefix(f.Name, "min-") && f.Name != "max-co-tenants" {
			return fmt.Errorf("--%s requires a value", f.Name)
		}
	}
	return nil
}
func booleanCommandFlag(n string) bool {
	switch n {
	case "recursive", "all", "all-pages", "prompt-stdin", "content-stdin", "session-cookie-stdin", "exclusive-node", "preview", "ndjson", "hydrate-tools", "launch":
		return true
	}
	return false
}
func contextualHelp(p parsedArgs) string {
	if len(p.Positionals) == 0 {
		return helpText() + workflowHelp("")
	}
	return "SAM CLI: " + strings.Join(p.Positionals, " ") + "\n\n" + workflowHelp(p.Positionals[0]) + "\nGlobal: --project <exact-name|full-id|unique-prefix> --json\nUnknown flags fail before HTTP. Resource IDs are full IDs. Reads never wake agents.\nWrites require explicit intent; CLI availability does not grant assistant permission.\nErrors: nonzero exit, JSON error on stderr with --json. No automatic write retries.\n"
}
func workflowHelp(family string) string {
	var b strings.Builder
	for _, c := range workflowContracts() {
		if family != "" && !strings.HasPrefix(c.command, family+" ") {
			continue
		}
		fmt.Fprintf(&b, "  sam %s", c.command)
		for i := 0; i < c.args; i++ {
			fmt.Fprintf(&b, " <id%d>", i+1)
		}
		fmt.Fprintf(&b, " [%s] (%s)\n", strings.Join(c.query, " | "), c.effect)
	}
	if family == "" || family == "tasks" {
		b.WriteString("  sam tasks submit <prompt> [--agent-profile <name-or-id>] [--skill <name-or-id>] [--prompt-file <path>|--prompt-stdin] (launches work)\n")
	}
	if family == "" || family == "chat" {
		b.WriteString("  sam chat export <session-id> [--output <path>] [--ndjson] (private transcript, read-only)\n  sam chat send <session-id> <content> (sends work)\n  sam chat cancel <session-id> (cancels current turn)\n  sam chat sleep <session-id> (resumable suspension)\n")
	}
	return b.String()
}

type structuredErrorWriter struct{ destination io.Writer }

func (w structuredErrorWriter) Write(p []byte) (int, error) {
	data, err := json.Marshal(map[string]any{"error": "CLI_ERROR", "message": strings.TrimSpace(string(p))})
	if err != nil {
		return 0, err
	}
	_, err = w.destination.Write(append(data, '\n'))
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func (w structuredErrorWriter) writeError(err error) {
	value := map[string]any{"error": "CLI_ERROR", "message": err.Error()}
	var apiErr APIError
	if errors.As(err, &apiErr) {
		value["error"] = apiErr.Code
		value["status"] = apiErr.Status
		value["message"] = apiErr.Message
	}
	b, e := json.Marshal(value)
	if e == nil {
		_, _ = w.destination.Write(append(b, '\n'))
	}
}
