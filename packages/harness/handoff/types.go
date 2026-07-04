// Package handoff generates SAM platform-compatible session handoff packets.
package handoff

// Packet mirrors packages/shared/src/types/mission.ts HandoffPacket.
type Packet struct {
	ID               string        `json:"id"`
	MissionID        string        `json:"missionId"`
	FromTaskID       string        `json:"fromTaskId"`
	ToTaskID         *string       `json:"toTaskId"`
	Summary          string        `json:"summary"`
	Facts            []Fact        `json:"facts"`
	OpenQuestions    []string      `json:"openQuestions"`
	ArtifactRefs     []ArtifactRef `json:"artifactRefs"`
	SuggestedActions []string      `json:"suggestedActions"`
	Version          int           `json:"version"`
	CreatedAt        int64         `json:"createdAt"`
}

// Fact mirrors packages/shared/src/types/mission.ts HandoffFact.
type Fact struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// ArtifactRef mirrors packages/shared/src/types/mission.ts HandoffArtifactRef.
type ArtifactRef struct {
	Type        ArtifactType `json:"type"`
	Ref         string       `json:"ref"`
	Description string       `json:"description,omitempty"`
}

// ArtifactType is the platform handoff artifact type union.
type ArtifactType string

const (
	ArtifactPR          ArtifactType = "pr"
	ArtifactFile        ArtifactType = "file"
	ArtifactLibraryFile ArtifactType = "library_file"
	ArtifactBranch      ArtifactType = "branch"
	ArtifactURL         ArtifactType = "url"
)
