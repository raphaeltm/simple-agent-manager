package cli

import (
	"fmt"
	"strings"
)

type parsedArgs struct {
	Globals         globalOptions
	Positionals     []string
	Flags           map[string]string
	Bools           map[string]bool
	MultiFlags      map[string][]string // flags that can appear multiple times
	FlagOccurrences []flagOccurrence
}

type globalOptions struct {
	JSON    bool
	Project string
}

type flagOccurrence struct {
	Name     string
	Value    string
	HasValue bool
}

var optionalBooleanFlags = map[string]struct{}{
	"exclusive-node": {},
}

func parseArgs(args []string) (parsedArgs, error) {
	parser := argParser{
		args: args,
		result: parsedArgs{
			Flags:      make(map[string]string),
			Bools:      make(map[string]bool),
			MultiFlags: make(map[string][]string),
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
		p.result.MultiFlags[name] = append(p.result.MultiFlags[name], value)
		p.result.FlagOccurrences = append(p.result.FlagOccurrences, flagOccurrence{Name: name, Value: value, HasValue: true})
		return nil
	}
	if _, ok := optionalBooleanFlags[name]; ok {
		if p.index < len(p.args) {
			if value, isBool := optionalBooleanFlagValue(p.args[p.index]); isBool {
				p.result.Flags[name] = value
				p.result.MultiFlags[name] = append(p.result.MultiFlags[name], value)
				p.result.FlagOccurrences = append(p.result.FlagOccurrences, flagOccurrence{Name: name, Value: value, HasValue: true})
				p.index++
				return nil
			}
		}
		p.result.Bools[name] = true
		p.result.FlagOccurrences = append(p.result.FlagOccurrences, flagOccurrence{Name: name})
		return nil
	}
	if p.index < len(p.args) && !strings.HasPrefix(p.args[p.index], "--") {
		v := p.args[p.index]
		p.result.Flags[name] = v
		p.result.MultiFlags[name] = append(p.result.MultiFlags[name], v)
		p.result.FlagOccurrences = append(p.result.FlagOccurrences, flagOccurrence{Name: name, Value: v, HasValue: true})
		p.index++
		return nil
	}
	p.result.Bools[name] = true
	p.result.FlagOccurrences = append(p.result.FlagOccurrences, flagOccurrence{Name: name})
	return nil
}

func optionalBooleanFlagValue(value string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if strings.EqualFold(trimmed, "true") || strings.EqualFold(trimmed, "false") {
		return trimmed, true
	}
	return "", false
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

func flagValues(multiFlags map[string][]string, name string) []string {
	return multiFlags[name]
}
