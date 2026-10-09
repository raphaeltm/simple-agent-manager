package cli

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

func runIdeaExecute(ctx context.Context, runtime Runtime, p parsedArgs, args []string) int {
	if len(args) != 1 {
		return fail(runtime.Stderr, fmt.Errorf("ideas execute requires one full Idea ID"))
	}
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	project, _, err := resolveProjectRef(ctx, client, p, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	var idea map[string]any
	if err = client.request(ctx, http.MethodGet, projectAPIPath(project, "tasks", args[0]), nil, &idea); err != nil {
		return fail(runtime.Stderr, err)
	}
	title, _ := idea["title"].(string)
	description, _ := idea["description"].(string)
	message := strings.TrimSpace(title + "\n\n" + description)
	if message == "" {
		return fail(runtime.Stderr, fmt.Errorf("Idea has no prompt"))
	}
	options, err := parseSubmitOptions(p)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if options.AgentProfile == "" {
		options.AgentProfile, _ = idea["agentProfileHint"].(string)
	}
	if options.Skill == "" {
		options.Skill, _ = idea["skillId"].(string)
	}
	if !p.Bools["launch"] {
		return writeWorkflow(runtime, p, map[string]any{"ideaId": args[0], "preparedPrompt": message, "agentProfile": options.AgentProfile, "skill": options.Skill, "launch": false})
	}
	if options.AgentProfile != "" {
		id, e := resolveNamedResource(ctx, client, project, "agent-profiles", options.AgentProfile)
		if e != nil {
			return fail(runtime.Stderr, e)
		}
		options.AgentProfile = id
	}
	if options.Skill != "" {
		id, e := resolveNamedResource(ctx, client, project, "skills", options.Skill)
		if e != nil {
			return fail(runtime.Stderr, e)
		}
		options.Skill = id
	}
	refs, err := attachmentReferences(ctx, runtime, client, project, p)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	options.Attachments = refs
	options.Mode = "conversation"
	client.idempotencyKey = p.Flags["idempotency-key"]
	response, err := client.SubmitTask(ctx, project, message, options)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	// Linking a queued session is separate from launching. Return its accepted
	// receipt even if linking fails so callers never redispatch blindly.
	var linked any
	client.idempotencyKey = ""
	if err = client.request(ctx, http.MethodPost, projectAPIPath(project, "sessions", response.SessionID, "ideas"), map[string]any{"taskId": args[0]}, &linked); err != nil {
		_ = writeWorkflow(runtime, p, map[string]any{"submission": response, "ideaLinked": false})
		return fail(runtime.Stderr, fmt.Errorf("work accepted but Idea link failed; reconcile the returned session instead of resubmitting"))
	}
	return writeWorkflow(runtime, p, map[string]any{"submission": response, "ideaLinked": true, "link": linked})
}
