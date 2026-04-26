// =============================================================================
// Mission Constants (Phase 2: Orchestration Primitives)
// All limits configurable via env vars (Constitution Principle XI)
// =============================================================================

/** Default max missions per project. Override via MISSION_MAX_PER_PROJECT env var. */
export const DEFAULT_MISSION_MAX_PER_PROJECT = 50;

/** Default max mission state entries per mission. Override via MISSION_MAX_STATE_ENTRIES env var. */
export const DEFAULT_MISSION_MAX_STATE_ENTRIES = 200;

/** Default max handoff packets per mission. Override via MISSION_MAX_HANDOFFS env var. */
export const DEFAULT_MISSION_MAX_HANDOFFS = 100;

/** Default max length for mission title. Override via MISSION_TITLE_MAX_LENGTH env var. */
export const DEFAULT_MISSION_TITLE_MAX_LENGTH = 200;

/** Default max length for mission description. Override via MISSION_DESCRIPTION_MAX_LENGTH env var. */
export const DEFAULT_MISSION_DESCRIPTION_MAX_LENGTH = 5000;

/** Default max length for mission state entry title. Override via MISSION_STATE_TITLE_MAX_LENGTH env var. */
export const DEFAULT_MISSION_STATE_TITLE_MAX_LENGTH = 200;

/** Default max length for mission state entry content. Override via MISSION_STATE_CONTENT_MAX_LENGTH env var. */
export const DEFAULT_MISSION_STATE_CONTENT_MAX_LENGTH = 2000;

/** Default max length for handoff summary. Override via HANDOFF_SUMMARY_MAX_LENGTH env var. */
export const DEFAULT_HANDOFF_SUMMARY_MAX_LENGTH = 5000;

/** Default max number of facts in a handoff packet. Override via HANDOFF_MAX_FACTS env var. */
export const DEFAULT_HANDOFF_MAX_FACTS = 50;

/** Default max number of open questions in a handoff. Override via HANDOFF_MAX_OPEN_QUESTIONS env var. */
export const DEFAULT_HANDOFF_MAX_OPEN_QUESTIONS = 20;

/** Default max number of artifact refs in a handoff. Override via HANDOFF_MAX_ARTIFACT_REFS env var. */
export const DEFAULT_HANDOFF_MAX_ARTIFACT_REFS = 30;

/** Default max number of suggested actions in a handoff. Override via HANDOFF_MAX_SUGGESTED_ACTIONS env var. */
export const DEFAULT_HANDOFF_MAX_SUGGESTED_ACTIONS = 20;

/** Default page size for mission list queries. Override via MISSION_LIST_PAGE_SIZE env var. */
export const DEFAULT_MISSION_LIST_PAGE_SIZE = 20;

/** Maximum page size for mission list queries. Override via MISSION_LIST_MAX_PAGE_SIZE env var. */
export const DEFAULT_MISSION_LIST_MAX_PAGE_SIZE = 100;
