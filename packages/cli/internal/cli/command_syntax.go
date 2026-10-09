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
	if err := validateFamilySyntax(p.Positionals); err != nil {
		return err
	}
	return validatePageNumbers(p)
}
func validateFamilySyntax(args []string) error {
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
		return validateSettingsSyntax(args, action)
	case "profiles", "skills":
		return validateMetadataSyntax(args, action, true)
	case "auth", "runner":
		if len(args) != 2 {
			return fmt.Errorf("%s requires one action and no extra arguments", family)
		}
	case "chat":
		return validateChatSyntax(args, action)
	case "tasks", "ideas":
		return validateMetadataSyntax(args, action, false)
	}
	return nil
}
func validateSettingsSyntax(args []string, action string) error {
	if len(args) <= 1 {
		return nil
	}
	if len(args) != 2 || action != "get" && action != "update" {
		return fmt.Errorf("settings accepts get or update without extra arguments")
	}
	return nil
}
func validateMetadataSyntax(args []string, action string, named bool) error {
	required := 0
	switch action {
	case "create":
		required = 2
	case "update":
		required = 3
	case "clone":
		if named {
			required = 3
		}
	case "wait":
		if !named {
			required = 3
		}
	}
	if required != 0 && len(args) != required {
		return fmt.Errorf("%s %s has invalid resource arguments", args[0], action)
	}
	return nil
}
func validateChatSyntax(args []string, action string) error {
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
	return nil
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
