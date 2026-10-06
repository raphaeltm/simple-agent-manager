package errorreport

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type diagnosticCanaryFixture struct {
	Fragments []string `json:"fragments"`
}

func mustLoadDiagnosticSecretCanaries() []string {
	path := filepath.Join("..", "..", "..", "..", "tests", "fixtures", "diagnostic-secret-canaries.json")
	data, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	var fixtures []diagnosticCanaryFixture
	if err := json.Unmarshal(data, &fixtures); err != nil {
		panic(err)
	}
	canaries := make([]string, 0, len(fixtures))
	for _, fixture := range fixtures {
		canaries = append(canaries, strings.Join(fixture.Fragments, ""))
	}
	return canaries
}

var credentialCanaries = mustLoadDiagnosticSecretCanaries()
var evidenceCanary = credentialCanaries[7]
