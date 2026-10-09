package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const submitFlagNames = "prompt prompt-file prompt-stdin agent agent-profile agent-profile-id skill context-summary devcontainer-config devcontainer-config-name mode node node-id parent-task parent-task-id provider min-vcpu min-memory-gb min-disk-gb exclusive-node vm-location vm-size workspace workspace-profile model max-co-tenants idempotency-key attachment attachment-ref-file"

func commandFlags(p parsedArgs) []string {
	c, _, ok := findWorkflow(p)
	if ok {
		flags := append([]string(nil), c.query...)
		if _, pageable := pagingFor(c.command); pageable {
			flags = append(flags, allPagesFlag)
		}
		if c.command == "library list" {
			flags = append(flags, "recursive", "all")
		}
		return flags
	}
	if len(p.Positionals) == 0 {
		return nil
	}
	return mutationCommandFlags(p)
}

func mutationCommandFlags(p parsedArgs) []string {
	family := p.Positionals[0]
	action := commandAction(p)
	if family == "projects" {
		return strings.Fields("limit cursor all-pages")
	}
	if family == "workspace" && len(p.Positionals) > 2 && p.Positionals[2] == "forward" {
		return strings.Fields("port local-port local-host")
	}
	if family == "chat" && (action == "fork" || action == "retry") {
		return derivedSubmitFlagNames("parent-task", "parent-task-id")
	}
	if family == "ideas" && action == "execute" {
		return derivedSubmitFlagNames("mode")
	}
	return strings.Fields(mutationFlagContracts()[family+" "+action])
}

func validateCommandFlags(p parsedArgs) error {
	if err := validateFlagAliases(p); err != nil {
		return err
	}
	allowed := map[string]bool{}
	for _, s := range commandFlags(p) {
		allowed[s] = true
	}
	seen := map[string]bool{}
	for _, f := range p.FlagOccurrences {
		if seen[f.Name] && f.Name != "attachment" {
			return fmt.Errorf("--%s may only be specified once", f.Name)
		}
		seen[f.Name] = true
		if !allowed[f.Name] {
			return fmt.Errorf("unknown flag --%s for %s", f.Name, commandLabel(p))
		}
		if !f.HasValue && !booleanCommandFlag(f.Name) && !strings.HasPrefix(f.Name, "min-") && f.Name != "max-co-tenants" {
			return fmt.Errorf("--%s requires a value", f.Name)
		}
	}
	return nil
}
func booleanCommandFlag(n string) bool {
	switch n {
	case "body-stdin", "recursive", "all", allPagesFlag, "prompt-stdin", "content-stdin", "session-cookie-stdin", "exclusive-node", "preview", "ndjson", "hydrate-tools", "launch":
		return true
	}
	return false
}
func contextualHelp(p parsedArgs) string {
	if len(p.Positionals) == 0 {
		return helpText() + workflowHelp("")
	}
	return "SAM CLI: " + commandLabel(p) + "\n\n" + workflowHelp(p.Positionals[0]) + "\nGlobal: --project <exact-name|full-id|unique-prefix> --json\nUnknown flags fail before HTTP. Resource IDs are full IDs. Reads never wake agents.\nWrites require explicit intent; CLI availability does not grant assistant permission.\nErrors: nonzero exit, JSON error on stderr with --json. No automatic write retries.\n"
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
		flags := append([]string(nil), c.query...)
		if _, pageable := pagingFor(c.command); pageable {
			flags = append(flags, allPagesFlag)
		}
		if len(flags) > 0 {
			fmt.Fprintf(&b, " [--%s]", strings.Join(flags, " | --"))
		}
		fmt.Fprintf(&b, " (%s)\n", c.effect)
	}
	if family == "" || family == "tasks" {
		b.WriteString("  sam tasks submit <prompt> [--agent-profile <name-or-id>] [--skill <name-or-id>] [--prompt-file <path>|--prompt-stdin] (launches work)\n")
	}
	if family == "" || family == "chat" {
		b.WriteString("  sam chat export <session-id> [--output <path>] [--ndjson] (private transcript, read-only)\n  sam chat send <session-id> <content> (sends work)\n  sam chat cancel <session-id> (cancels current turn)\n  sam chat sleep <session-id> (resumable suspension)\n")
	}
	b.WriteString(mutationHelp(family))
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

func mutationHelp(family string) string {
	lines := map[string]string{
		"tasks":    "  sam tasks create --title <text> [--description <text>] [--priority <n>] (draft metadata)\n  sam tasks update <id> [--title <text>] [--description <text>] [--priority <n>]\n  sam tasks wait <id> [--timeout 30m] [--interval 2s] (read-only; exits 3 timeout, 4 failed/cancelled)\n  sam task submit <project-id> <prompt> (legacy alias)\n  sam task status <project-id> <task-id> (legacy alias)\n",
		"ideas":    "  sam ideas create --title <text> [--description <text>] [--priority <n>]\n  sam ideas update <id> [--title <text>] [--description <text>] [--priority <n>]\n  sam ideas execute <id> [--launch] (prepare by default; launch creates work and links Idea)\n",
		"profiles": "  sam profiles clone <source-name-or-id> --name <new-name> [--preview] (metadata only; configuration not copied)\n  sam profiles create --name <text> [--description <text>] [--idempotency-key <key>]\n  sam profiles update <name-or-id> [--name <text>] [--description <text>] [--expected-updated-at <version>] [--preview] (project metadata only)\n",
		"skills":   "  sam skills clone <source-name-or-id> --name <new-name> [--preview] (metadata only; configuration not copied)\n  sam skills create --name <text> [--description <text>] [--idempotency-key <key>]\n  sam skills update <name-or-id> [--name <text>] [--description <text>] [--expected-updated-at <version>] [--preview] (project metadata only)\n",
		"settings": "  sam settings [get] (safe metadata; runtime values masked)\n  sam settings update [--name <text>] [--description <text>] [--preview] (routine project metadata only)\n",
		"comments": "  sam comments add <session-id> <message-id> --body <text> [--idempotency-key <key>]\n  sam comments reply <session-id> <thread-id> --body <text> [--idempotency-key <key>]\n  sam comments resolve <session-id> <thread-id> [--idempotency-key <key>]\n  sam comments reopen <session-id> <thread-id> [--idempotency-key <key>] (notes only; no agent send)\n  Comment input: --body <text> | --body-file <path> | --body-stdin\n",
		"chat":     "  sam chat answer <session-id> <marker-id> --answer <exact-option> (offered needs_input options only; rejects permission/auth interactions)\n  sam chat fork <id> [--launch] (prepare lineage; explicit launch creates work)\n  sam chat retry <id> [--launch] (prepare original prompt; explicit launch creates work)\n",
		"files":    "  sam files download --ref <ref> --path <path> --output <new-file> (read-only)\n",
		"library":  "  sam library upload <local-file> [--directory <path>] [--description <text>] (creates artifact; no automatic retry)\n  sam library download <id> --output <new-file> (read-only)\n",
	}
	var b strings.Builder
	for _, key := range []string{"tasks", "ideas", "profiles", "skills", "settings", "chat", "comments", "files", "library"} {
		if family == "" || family == key {
			b.WriteString(lines[key])
		}
	}
	if family == "" || family == "tasks" || family == "chat" {
		b.WriteString("  Submit flags: " + strings.ReplaceAll(strings.Join(strings.Fields(submitFlagNames), ", "), "max-co-tenants, ", "") + "\n  Resource flags set explicit placement requirements. --model is reserved and fails.\n  --attachment uploads private bytes; keyed retries should reuse --attachment-ref-file or reconcile receipts.\n")
	}
	return b.String()
}

// Lineage and Ideas derive their prompt from the source resource.
func derivedSubmitFlagNames(excluded ...string) []string {
	var flags []string
	for _, name := range strings.Fields(submitFlagNames + " launch") {
		if name != "prompt" && name != "prompt-file" && name != "prompt-stdin" && !containsFlag(excluded, name) {
			flags = append(flags, name)
		}
	}
	return flags
}

func commandLabel(p parsedArgs) string {
	if len(p.Positionals) == 0 {
		return "sam"
	}
	if len(p.Positionals) > 1 && isKnownCommandAction(p.Positionals[1]) {
		return p.Positionals[0] + " " + p.Positionals[1]
	}
	return p.Positionals[0]
}

func isKnownCommandAction(action string) bool {
	for _, known := range strings.Fields("list get submit dispatch create update wait export send answer fork retry execute cancel sleep clone resolve download upload reply reopen add status new login logout token") {
		if action == known {
			return true
		}
	}
	return false
}

// Informational events retain credential redaction without error classification.
func writeDiagnostic(destination io.Writer, data []byte) {
	switch writer := destination.(type) {
	case redactingWriter:
		inner := writer.destination
		if structured, ok := inner.(structuredErrorWriter); ok {
			inner = structured.destination
		}
		writer.destination = inner
		_, _ = writer.Write(append(data, '\n'))
	case structuredErrorWriter:
		_, _ = writer.destination.Write(append(data, '\n'))
	default:
		_, _ = destination.Write(append(data, '\n'))
	}
}

func containsFlag(flags []string, name string) bool {
	for _, flag := range flags {
		if flag == name {
			return true
		}
	}
	return false
}

func commandAction(p parsedArgs) string {
	if len(p.Positionals) > 1 {
		return p.Positionals[1]
	}
	return ""
}
func validateFlagAliases(p parsedArgs) error {
	for _, aliases := range [][]string{{"agent-profile", "agent-profile-id"}, {"node", "node-id"}, {"parent-task", "parent-task-id"}, {"workspace", "workspace-profile"}, {"devcontainer-config", "devcontainer-config-name"}} {
		if _, first := p.Flags[aliases[0]]; first {
			if _, second := p.Flags[aliases[1]]; second {
				return fmt.Errorf("--%s and --%s cannot be combined", aliases[0], aliases[1])
			}
		}
	}
	return nil
}
func mutationFlagContracts() map[string]string {
	return map[string]string{
		"comments add": "body body-file body-stdin idempotency-key", "comments reply": "body body-file body-stdin idempotency-key",
		"comments resolve": "idempotency-key", "comments reopen": "idempotency-key",
		"files download": "ref path output", "library download": "output", "library upload": "directory description filename mimeType",
		"auth login": "api-url token session-cookie session-cookie-stdin", "chat new": submitFlagNames,
		"chat export": "limit output ndjson hydrate-tools", "chat answer": "answer", "chat send": "content content-file content-stdin idempotency-key",
		"task submit": submitFlagNames, "task dispatch": submitFlagNames, "tasks submit": submitFlagNames, "tasks dispatch": submitFlagNames,
		"task create": taskMetadataFlags, "task update": taskMetadataFlags, "task wait": waitFlagNames,
		"tasks create": taskMetadataFlags, "tasks update": taskMetadataFlags, "tasks wait": waitFlagNames,
		"ideas create": taskMetadataFlags, "ideas update": taskMetadataFlags,
		"profiles create": createMetadataFlags, "profiles clone": createMetadataFlags, "profiles update": updateMetadataFlags,
		"skills create": createMetadataFlags, "skills clone": createMetadataFlags, "skills update": updateMetadataFlags,
		"settings update": "name description preview",
	}
}

const taskMetadataFlags = "title description priority preview"
const createMetadataFlags = "name description preview idempotency-key"
const updateMetadataFlags = "name description preview expected-updated-at"
const allPagesFlag = "all-pages"

const waitFlagNames = "timeout interval"
