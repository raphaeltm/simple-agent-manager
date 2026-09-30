package acp

import (
	"encoding/json"
	"os"
	"testing"
)

func TestAcpFormValidationMatchesSharedCorpus(t *testing.T) {
	raw, err := os.ReadFile("../../../shared/test-fixtures/acp-forms.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name        string         `json:"name"`
		Schema      map[string]any `json:"schema"`
		ValidSchema bool           `json:"validSchema"`
		Limits      struct {
			SchemaMaxBytes int `json:"schemaMaxBytes"`
			PropertiesMax  int `json:"propertiesMax"`
			EnumMax        int `json:"enumMax"`
			AnswerMaxBytes int `json:"answerMaxBytes"`
			StringMaxBytes int `json:"stringMaxBytes"`
		} `json:"limits"`
		Answers []struct {
			Content map[string]any `json:"content"`
			Valid   bool           `json:"valid"`
		} `json:"answers"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range cases {
		t.Run(fixture.Name, func(t *testing.T) {
			limits := acpFormLimits{schemaBytes: 16 * 1024, properties: 20, enum: 50,
				answerBytes: 16 * 1024, stringBytes: 4 * 1024, keyChars: 128, labelChars: 200}
			if fixture.Limits.SchemaMaxBytes > 0 {
				limits.schemaBytes = fixture.Limits.SchemaMaxBytes
			}
			if fixture.Limits.PropertiesMax > 0 {
				limits.properties = fixture.Limits.PropertiesMax
			}
			if fixture.Limits.EnumMax > 0 {
				limits.enum = fixture.Limits.EnumMax
			}
			if fixture.Limits.AnswerMaxBytes > 0 {
				limits.answerBytes = fixture.Limits.AnswerMaxBytes
			}
			if fixture.Limits.StringMaxBytes > 0 {
				limits.stringBytes = fixture.Limits.StringMaxBytes
			}
			valid := validateAcpFormSchema(fixture.Schema, limits)
			if valid != fixture.ValidSchema {
				t.Fatalf("schema valid=%v, want %v", valid, fixture.ValidSchema)
			}
			if !valid {
				return
			}
			for index, answer := range fixture.Answers {
				got := validateAcpFormAnswer(fixture.Schema, answer.Content, limits)
				if got != answer.Valid {
					t.Errorf("answer %d valid=%v, want %v", index, got, answer.Valid)
				}
			}
		})
	}
}
