package cli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// PickProject displays an interactive numbered list and returns the selected project.
// Uses simple line-based input (no raw terminal mode) to stay dependency-free.
func PickProject(ctx context.Context, client APIClient, stdin io.Reader, stdout io.Writer) (Project, error) {
	projects, err := client.ListProjects(ctx)
	if err != nil {
		return Project{}, fmt.Errorf("failed to list projects: %w", err)
	}
	if len(projects.Projects) == 0 {
		return Project{}, fmt.Errorf("no projects found. Create one at the SAM web app")
	}

	fmt.Fprintln(stdout, "Select a project:")
	fmt.Fprintln(stdout)
	for i, p := range projects.Projects {
		activity := FormatAnyTimestamp(p.LastActivityAt)
		chats := "no chats"
		if p.ActiveSessionCount == 1 {
			chats = "1 active chat"
		} else if p.ActiveSessionCount > 1 {
			chats = fmt.Sprintf("%d active chats", p.ActiveSessionCount)
		}
		detail := chats
		if activity != "" {
			detail += ", " + activity
		}
		fmt.Fprintf(stdout, "  %d. %s — %s (%s)\n", i+1, p.Name, or(p.Repository, "no repo"), detail)
	}
	fmt.Fprintln(stdout)
	fmt.Fprint(stdout, "Enter number: ")

	scanner := bufio.NewScanner(stdin)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return Project{}, fmt.Errorf("reading selection: %w", err)
		}
		return Project{}, fmt.Errorf("no input received")
	}
	input := strings.TrimSpace(scanner.Text())
	if input == "" {
		return Project{}, fmt.Errorf("no selection made")
	}

	num, err := strconv.Atoi(input)
	if err != nil || num < 1 || num > len(projects.Projects) {
		return Project{}, fmt.Errorf("invalid selection %q. Enter a number between 1 and %d", input, len(projects.Projects))
	}

	return projects.Projects[num-1], nil
}
