package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func runAuth(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	if len(args) == 0 {
		return fail(runtime.Stderr, errors.New("auth requires an action"))
	}
	switch args[0] {
	case "login":
		return runAuthLogin(ctx, runtime, parsed)
	case "status":
		return runAuthStatus(ctx, runtime, parsed)
	default:
		return fail(runtime.Stderr, fmt.Errorf("unknown auth action: %s", args[0]))
	}
}

func runAuthLogin(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	apiURL := resolveLoginAPIURL(runtime, parsed)
	token := flagValue(parsed.Flags, "token")
	if token != "" {
		return runTokenLogin(ctx, runtime, parsed, apiURL, token)
	}

	cookie, err := readSessionCookie(runtime, parsed)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if cookie != "" {
		return saveAuthConfig(runtime, parsed, normalizeAPIURL(apiURL), cookie, AuthUser{})
	}

	return runDeviceFlow(ctx, runtime, parsed, apiURL)
}

const defaultAPIURL = "https://api.simple-agent-manager.org"

func resolveLoginAPIURL(runtime Runtime, parsed parsedArgs) string {
	if apiURL := flagValue(parsed.Flags, "api-url"); apiURL != "" {
		return apiURL
	}
	config, err := LoadConfig(runtime.Env)
	if err == nil && config != nil {
		return config.APIURL
	}
	if envURL := strings.TrimSpace(runtime.Env.Getenv("SAM_API_URL")); envURL != "" {
		return envURL
	}
	return defaultAPIURL
}

func runTokenLogin(ctx context.Context, runtime Runtime, parsed parsedArgs, apiURL string, token string) int {
	response, err := ExchangeAPIToken(ctx, runtime.HTTPClient, apiURL, token)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return saveAuthConfig(runtime, parsed, normalizeAPIURL(apiURL), response.SessionCookie, response.User)
}

func runDeviceFlow(ctx context.Context, runtime Runtime, parsed parsedArgs, apiURL string) int {
	code, err := CreateDeviceCode(ctx, runtime.HTTPClient, apiURL)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if code.Interval <= 0 {
		code.Interval = 5
	}
	if code.ExpiresIn <= 0 {
		code.ExpiresIn = 900
	}

	if parsed.Globals.JSON {
		data, _ := json.Marshal(map[string]any{"authorizationRequired": true, "verificationUrl": code.VerificationURIComplete, "userCode": code.UserCode})
		writeDiagnostic(runtime.Stderr, data)
	} else {
		fmt.Fprintf(runtime.Stdout, "Open this URL to authorize SAM CLI:\n%s\n\nUser code: %s\n", code.VerificationURIComplete, code.UserCode)
	}
	if !parsed.Globals.JSON {
		tryOpenBrowser(ctx, runtime, code.VerificationURIComplete)
	}

	response, err := pollDeviceToken(ctx, runtime, apiURL, code)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if !parsed.Globals.JSON {
		fmt.Fprintln(runtime.Stdout)
	}
	return saveAuthConfig(runtime, parsed, normalizeAPIURL(apiURL), response.SessionCookie, response.User)
}

func pollDeviceToken(ctx context.Context, runtime Runtime, apiURL string, code DeviceCodeResponse) (TokenLoginResponse, error) {
	deadline := time.Now().Add(time.Duration(code.ExpiresIn) * time.Second)
	interval := time.Duration(code.Interval) * time.Second
	for {
		response, err := ExchangeDeviceCode(ctx, runtime.HTTPClient, apiURL, code.DeviceCode)
		if err == nil {
			return response, nil
		}
		var apiErr APIError
		if !errors.As(err, &apiErr) {
			return TokenLoginResponse{}, err
		}
		interval, err = handleDevicePollError(runtime, apiErr, interval)
		if err != nil {
			return TokenLoginResponse{}, err
		}
		if time.Now().Add(interval).After(deadline) {
			return TokenLoginResponse{}, errors.New("code expired. Run `sam auth login` again")
		}
		if err := sleepContext(ctx, interval); err != nil {
			return TokenLoginResponse{}, err
		}
	}
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func tryOpenBrowser(ctx context.Context, runtime Runtime, url string) {
	commands := browserCommands(runtime.Runner.GOOS(), url)
	for _, command := range commands {
		if _, err := runtime.Runner.LookPath(command.name); err != nil {
			continue
		}
		_, _ = runtime.Runner.Command(ctx, command.name, command.args...)
		return
	}
}

type browserCommand struct {
	name string
	args []string
}

func browserCommands(goos, target string) []browserCommand {
	switch goos {
	case "darwin":
		return []browserCommand{{name: "open", args: []string{target}}}
	case "windows":
		return []browserCommand{{name: "rundll32", args: []string{"url.dll,FileProtocolHandler", target}}}
	default:
		return []browserCommand{{name: "xdg-open", args: []string{target}}}
	}
}

func saveAuthConfig(runtime Runtime, parsed parsedArgs, apiURL, sessionCookie string, user AuthUser) int {
	config := CLIConfig{APIURL: normalizeAPIURL(apiURL), SessionCookie: sessionCookie}
	paths, err := SaveConfig(runtime.Env, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	text := "Authenticated"
	if user.Email != "" || user.Name != "" {
		text = "Authenticated as " + formatAuthUser(user)
	}
	text += fmt.Sprintf("\nSaved SAM CLI auth config to %s", paths.ConfigFile)
	value := map[string]any{
		"authenticated": true,
		"apiUrl":        config.APIURL,
		"configFile":    paths.ConfigFile,
		"sessionCookie": redactSecret(config.SessionCookie),
		"user":          user,
	}
	return writeOrFail(runtime, parsed.Globals.JSON, text, value)
}

func formatAuthUser(user AuthUser) string {
	if user.Name != "" && user.Email != "" {
		return fmt.Sprintf("%s <%s>", user.Name, user.Email)
	}
	if user.Email != "" {
		return user.Email
	}
	if user.Name != "" {
		return user.Name
	}
	return "user"
}

func readSessionCookie(runtime Runtime, parsed parsedArgs) (string, error) {
	cookie := flagValue(parsed.Flags, "session-cookie")
	if !parsed.Bools["session-cookie-stdin"] {
		return cookie, nil
	}
	if cookie != "" {
		return "", errors.New("use either --session-cookie or --session-cookie-stdin, not both")
	}
	read, err := io.ReadAll(bufio.NewReader(runtime.Stdin))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(read)), nil
}

func runAuthStatus(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	config, source, err := resolveAuthenticatedConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	paths, err := ResolveConfigPaths(runtime.Env)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if config == nil {
		text := fmt.Sprintf("Not authenticated. Expected config at %s", paths.ConfigFile)
		if err := writeOutput(runtime.Stdout, parsed.Globals.JSON, text, map[string]any{"authenticated": false, "configFile": paths.ConfigFile}); err != nil {
			return fail(runtime.Stderr, err)
		}
		return 1
	}
	text := strings.Join([]string{
		"Authenticated",
		"apiUrl: " + config.APIURL,
		"sessionCookie: " + redactSecret(config.SessionCookie),
		"source: " + source,
		"configFile: " + paths.ConfigFile,
	}, "\n")
	value := map[string]any{
		"authenticated": true,
		"apiUrl":        config.APIURL,
		"configFile":    paths.ConfigFile,
		"sessionCookie": redactSecret(config.SessionCookie),
		"source":        source,
	}
	return writeOrFail(runtime, parsed.Globals.JSON, text, value)
}

func handleDevicePollError(runtime Runtime, apiErr APIError, interval time.Duration) (time.Duration, error) {
	switch {
	case apiErr.Status == http.StatusPreconditionRequired || apiErr.Code == "authorization_pending":
		if !containsJSONFlag(runtime.Args) {
			fmt.Fprint(runtime.Stdout, ".")
		}
	case apiErr.Status == http.StatusTooManyRequests || apiErr.Code == "slow_down":
		interval += 5 * time.Second
		if !containsJSONFlag(runtime.Args) {
			fmt.Fprint(runtime.Stdout, ".")
		}
	case apiErr.Status == http.StatusGone || apiErr.Code == "expired_token":
		return interval, errors.New("code expired. Run `sam auth login` again")
	default:
		return interval, apiErr
	}
	return interval, nil
}
