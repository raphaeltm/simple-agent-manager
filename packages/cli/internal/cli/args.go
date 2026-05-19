package cli

import (
	"fmt"
	"strings"
)

type parsedArgs struct {
	Globals     globalOptions
	Positionals []string
	Flags       map[string]string
	Bools       map[string]bool
}

type globalOptions struct {
	JSON    bool
	Project string
}

func parseArgs(args []string) (parsedArgs, error) {
	result := parsedArgs{
		Flags: make(map[string]string),
		Bools: make(map[string]bool),
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--json" {
			result.Globals.JSON = true
			continue
		}
		if value, ok := strings.CutPrefix(arg, "--project="); ok {
			result.Globals.Project = value
			continue
		}
		if arg == "--project" {
			i++
			if i >= len(args) {
				return result, fmt.Errorf("--project requires a value")
			}
			result.Globals.Project = args[i]
			continue
		}
		if strings.HasPrefix(arg, "--") {
			name, value, hasValue := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			if name == "" {
				return result, fmt.Errorf("invalid flag %q", arg)
			}
			if hasValue {
				result.Flags[name] = value
				continue
			}
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				i++
				result.Flags[name] = args[i]
				continue
			}
			result.Bools[name] = true
			continue
		}
		result.Positionals = append(result.Positionals, arg)
	}
	return result, nil
}

func projectFromArgs(globals globalOptions, args []string, usage string) (string, []string, error) {
	if globals.Project != "" {
		return globals.Project, args, nil
	}
	if len(args) == 0 {
		return "", nil, fmt.Errorf("%s requires --project or <projectId>", usage)
	}
	return args[0], args[1:], nil
}

func flagValue(flags map[string]string, names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(flags[name]); value != "" {
			return value
		}
	}
	return ""
}
