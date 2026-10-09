package cli

import (
	"fmt"
	"strconv"
)

func validateCommandSyntax(p parsedArgs) error {
	if c, args, ok := findWorkflow(p); ok {
		if len(args) != c.args {
			return fmt.Errorf("sam %s requires %d resource argument(s)", c.command, c.args)
		}
		return validatePageNumbers(p)
	}
	args := p.Positionals
	if len(args) == 0 {
		return nil
	}
	family := args[0]
	action := ""
	if len(args) > 1 {
		action = args[1]
	}
	switch family {
	case "projects", "status", "nodes":
		if len(args) != 1 {
			return fmt.Errorf("sam %s takes no positional arguments", family)
		}
	case "settings":
		if len(args) > 1 && (action != "get" && action != "update" || len(args) != 2) {
			return fmt.Errorf("settings accepts get or update without extra arguments")
		}
	case "profiles", "skills":
		if action == "create" && len(args) != 2 || (action == "update" || action == "clone") && len(args) != 3 {
			return fmt.Errorf("%s %s has invalid resource arguments", family, action)
		}
	case "auth", "runner":
		if len(args) != 2 {
			return fmt.Errorf("%s requires one action and no extra arguments", family)
		}
	case "chat":
		switch action {
		case "export", "cancel", "sleep", "fork", "retry":
			if len(args) != 3 {
				return fmt.Errorf("chat %s requires exactly one session ID", action)
			}
		case "send":
			if len(args) < 3 {
				return fmt.Errorf("chat send requires a session ID")
			}
		}
	case "tasks", "ideas":
		if action == "create" && len(args) != 2 || action == "update" && len(args) != 3 || action == "wait" && len(args) != 3 {
			return fmt.Errorf("%s %s has invalid resource arguments", family, action)
		}
	}
	return validatePageNumbers(p)
}
func validatePageNumbers(p parsedArgs) error {
	for _, key := range []string{"limit", "offset"} {
		if raw, ok := p.Flags[key]; ok {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 0 || key == "limit" && n == 0 {
				return fmt.Errorf("--%s must be a %s integer", key, map[bool]string{true: "positive", false: "non-negative"}[key == "limit"])
			}
		}
	}
	return nil
}
