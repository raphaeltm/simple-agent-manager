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
	parser := argParser{
		args: args,
		result: parsedArgs{
			Flags: make(map[string]string),
			Bools: make(map[string]bool),
		},
	}
	for parser.index < len(parser.args) {
		if err := parser.parseNext(); err != nil {
			return parser.result, err
		}
	}
	return parser.result, nil
}

type argParser struct {
	args   []string
	index  int
	result parsedArgs
}

func (p *argParser) parseNext() error {
	arg := p.args[p.index]
	p.index++

	if arg == "--json" {
		p.result.Globals.JSON = true
		return nil
	}
	if value, ok := strings.CutPrefix(arg, "--project="); ok {
		p.result.Globals.Project = value
		return nil
	}
	if arg == "--project" {
		return p.readProjectValue()
	}
	if strings.HasPrefix(arg, "--") {
		return p.parseFlag(arg)
	}
	p.result.Positionals = append(p.result.Positionals, arg)
	return nil
}

func (p *argParser) readProjectValue() error {
	if p.index >= len(p.args) {
		return fmt.Errorf("--project requires a value")
	}
	p.result.Globals.Project = p.args[p.index]
	p.index++
	return nil
}

func (p *argParser) parseFlag(arg string) error {
	name, value, hasValue := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
	if name == "" {
		return fmt.Errorf("invalid flag %q", arg)
	}
	if hasValue {
		p.result.Flags[name] = value
		return nil
	}
	if p.index < len(p.args) && !strings.HasPrefix(p.args[p.index], "--") {
		p.result.Flags[name] = p.args[p.index]
		p.index++
		return nil
	}
	p.result.Bools[name] = true
	return nil
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
