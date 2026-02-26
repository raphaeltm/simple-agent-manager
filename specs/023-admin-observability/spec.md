# Feature Specification: Admin Observability Dashboard

**Feature Branch**: `023-admin-observability`
**Created**: 2026-02-25
**Status**: Draft
**Input**: User description: "Admin observability dashboard with real-time logs, historical log viewer, error aggregation, and platform metrics for superadmin visibility into system health"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View Aggregated Platform Errors (Priority: P1)

As a platform admin, I want to see a consolidated view of all errors happening across the system (browser client errors, VM agent errors, API errors) so I can quickly identify and triage problems without logging into the Cloudflare dashboard.

**Why this priority**: Errors are the most actionable observability data. The admin's primary pain point is not knowing when things break. This delivers immediate diagnostic value by surfacing errors that are already being collected but only visible in the Cloudflare console today.

**Independent Test**: Can be fully tested by triggering known errors from the client, VM agent, and API, then verifying they appear in the admin error view with correct source attribution, timestamps, and context.

**Acceptance Scenarios**:

1. **Given** the admin navigates to the observability section, **When** the page loads, **Then** a list of recent errors from all sources (client, VM agent, API) is displayed in reverse chronological order with source labels.
2. **Given** errors exist from multiple sources, **When** the admin filters by source (e.g., "client" only), **Then** only errors from that source are displayed.
3. **Given** an error was reported by the client error reporter, **When** it appears in the error list, **Then** it shows the error message, stack trace, page URL, browser info, timestamp, and associated user (if authenticated).
4. **Given** the admin wants to find a specific error, **When** they type in the search box, **Then** errors are filtered by message content in real-time.
5. **Given** errors span multiple days, **When** the admin selects a time range, **Then** only errors within that range are displayed.

---

### User Story 2 - Platform Health Overview (Priority: P1)

As a platform admin, I want to see a dashboard summary of system health at a glance so I can quickly assess whether the platform is operating normally.

**Why this priority**: A health overview provides the "is everything OK?" signal that an admin checks first. It contextualizes individual errors and surfaces problems even when the admin hasn't been watching.

**Independent Test**: Can be fully tested by verifying the dashboard displays correct counts for active nodes, workspaces, running tasks, and error counts, and that these update when the underlying state changes.

**Acceptance Scenarios**:

1. **Given** the admin opens the observability dashboard, **When** the page loads, **Then** summary cards show: total active nodes, total active workspaces, tasks in progress, and error count (last 24 hours).
2. **Given** an error rate is elevated, **When** the dashboard loads, **Then** the error count card visually indicates the elevated state (e.g., warning color).
3. **Given** no nodes or workspaces are active, **When** the dashboard loads, **Then** the summary cards show zero values rather than loading indefinitely or erroring.

---

### User Story 3 - Historical API Worker Log Viewer (Priority: P2)

As a platform admin, I want to query and browse historical API Worker logs from within the admin UI so I can investigate issues without switching to the Cloudflare dashboard.

**Why this priority**: Historical logs are essential for post-incident investigation. While real-time logs help catch issues as they happen, most debugging happens after the fact. This leverages the Cloudflare Workers Observability API to bring logs in-app.

**Independent Test**: Can be fully tested by querying the log viewer for a known time range and verifying that API Worker logs appear with correct timestamps, levels, and structured data matching what the Cloudflare dashboard shows.

**Acceptance Scenarios**:

1. **Given** the admin opens the log viewer tab, **When** the page loads, **Then** recent API Worker logs are displayed with timestamp, level, event name, and details.
2. **Given** the admin selects a log level filter (e.g., "error" only), **When** the filter is applied, **Then** only logs at that level or higher severity are shown.
3. **Given** the admin specifies a time range (e.g., "last 1 hour"), **When** the query runs, **Then** only logs within that range are returned.
4. **Given** the admin types a search term, **When** the search executes, **Then** logs matching that term in their message or event name are returned.
5. **Given** the log query returns many results, **When** the admin scrolls to the bottom, **Then** additional results are loaded (pagination or infinite scroll).
6. **Given** the Cloudflare Observability API is unreachable or returns an error, **When** the admin views the log viewer, **Then** a clear error message is shown explaining the issue.

---

### User Story 4 - Real-Time Log Stream (Priority: P2)

As a platform admin, I want to subscribe to a live stream of platform logs so I can monitor what's happening in real time while debugging or during deployments.

**Why this priority**: Real-time visibility is critical during active debugging sessions and deployments. While historical logs cover most cases, live streaming lets the admin correlate actions with immediate effects.

**Independent Test**: Can be fully tested by opening the real-time stream, triggering API requests, and verifying log entries appear in the stream within seconds.

**Acceptance Scenarios**:

1. **Given** the admin opens the real-time logs tab, **When** the stream connects, **Then** a connection status indicator shows "Connected" and new log entries begin appearing.
2. **Given** the stream is active, **When** an API request is processed by the Worker, **Then** the corresponding log entry appears in the stream within 5 seconds.
3. **Given** the stream is active, **When** the admin selects a severity filter (e.g., "warn" and above), **Then** only log entries matching that filter appear in the stream.
4. **Given** the stream is active and producing logs quickly, **When** the admin clicks "Pause", **Then** the stream stops displaying new entries while buffering them, and a "Resume" action shows the buffered entries.
5. **Given** the WebSocket connection drops, **When** the stream detects disconnection, **Then** the status indicator shows "Reconnecting" and the stream auto-reconnects.

---

### User Story 5 - Error Trend Visualization (Priority: P3)

As a platform admin, I want to see error trends over time so I can identify patterns, regressions, and the impact of deployments.

**Why this priority**: Trend data provides higher-level insight than individual error entries. It helps the admin answer "is this getting better or worse?" and correlate spikes with specific events. Deferred to P3 because the raw error list (P1) provides the foundational data.

**Independent Test**: Can be fully tested by generating errors at known times and verifying the trend chart correctly plots them over the selected time window.

**Acceptance Scenarios**:

1. **Given** the admin views the error trends section, **When** the data loads, **Then** a time-series chart shows error counts grouped by time interval (e.g., per hour) for the selected period.
2. **Given** errors from different sources exist, **When** the admin views the chart, **Then** error counts are broken down by source (client, VM agent, API) with distinct visual treatments.
3. **Given** the admin changes the time range, **When** the new range is selected, **Then** the chart updates to reflect the new period with appropriate time granularity.

---

### Edge Cases

- What happens when the platform has zero errors in the selected time range? The dashboard shows an empty state with a positive message (e.g., "No errors in this period").
- What happens when the Cloudflare Observability API rate limits requests? The system shows a user-friendly message and suggests waiting before retrying, with a configurable backoff.
- What happens when the admin's session expires while viewing the real-time stream? The stream disconnects gracefully, and the UI prompts re-authentication.
- What happens when error volume is extremely high (thousands per minute)? The real-time stream samples or batches entries to prevent browser performance degradation. Historical views use server-side pagination.
- What happens when the platform has never been configured with the required Cloudflare credentials for the Observability API? The log viewer tab shows a setup prompt explaining which credentials are needed.
- What happens when multiple admins view the real-time stream simultaneously? Each admin receives their own independent stream with their own filter settings.

## Requirements *(mandatory)*

### Functional Requirements

**Error Aggregation & Storage**

- **FR-001**: System MUST persist platform errors (client errors, VM agent errors, and API Worker error-level logs) to a queryable store in addition to re-logging them to Workers console, enabling in-app querying independent of Cloudflare's Observability API.
- **FR-002**: Each stored error MUST include: source (client, vm-agent, api), level, message, stack trace (if available), timestamp, user ID (if available), additional context (page URL, node ID, etc.).
- **FR-003**: System MUST enforce a configurable retention period for stored errors, with a default of 30 days.
- **FR-004**: System MUST enforce a configurable maximum storage limit for errors, automatically purging oldest entries when the limit is reached.

**Admin Dashboard**

- **FR-005**: System MUST provide an admin observability section accessible only to superadmin users.
- **FR-006**: The observability dashboard MUST display summary health metrics: active node count, active workspace count, in-progress task count, and error count for the last 24 hours.
- **FR-007**: The dashboard MUST display a list of recent errors from all sources, sorted by most recent first.
- **FR-008**: The error list MUST support filtering by: source (client, vm-agent, api), severity level, time range, and free-text search.
- **FR-009**: The error list MUST support pagination to handle large volumes.

**Historical Log Viewer**

- **FR-010**: System MUST provide an API endpoint that proxies queries to the Cloudflare Workers Observability API using platform credentials (CF_API_TOKEN, CF_ACCOUNT_ID).
- **FR-011**: The historical log viewer MUST display API Worker logs with: timestamp, log level, event/message, and structured detail fields.
- **FR-012**: The log viewer MUST support filtering by log level, time range, and free-text search.
- **FR-013**: The log viewer MUST support pagination or cursor-based loading for large result sets.
- **FR-014**: System MUST handle Cloudflare API errors gracefully with user-friendly messages and MUST NOT expose raw API error details or credentials.
- **FR-015**: System MUST rate-limit log viewer queries to prevent abuse of the Cloudflare API, with configurable limits.

**Real-Time Log Stream**

- **FR-016**: System MUST provide a real-time log stream that delivers new platform log entries to connected admin clients via WebSocket.
- **FR-017**: The real-time stream MUST support server-side filtering by severity level so only relevant entries are transmitted.
- **FR-018**: The real-time stream MUST display a connection status indicator (connected, reconnecting, disconnected).
- **FR-019**: The real-time stream MUST auto-reconnect on connection loss with configurable backoff.
- **FR-020**: The real-time stream MUST support pause/resume to allow the admin to inspect entries without losing new data.

**Error Trends**

- **FR-021**: System MUST provide aggregated error counts grouped by configurable time intervals (hourly, daily) and by source.
- **FR-022**: The error trend visualization MUST support adjustable time ranges (last hour, last 24 hours, last 7 days, last 30 days).

**Configuration**

- **FR-023**: All thresholds, limits, retention periods, and intervals MUST be configurable via environment variables with sensible defaults (per Constitution Principle XI).
- **FR-024**: The feature MUST work for self-hosted deployments where the admin provides their own Cloudflare credentials (per Constitution Principle XII).

### Key Entities

- **PlatformError**: A recorded error from any source. Attributes: id, source (client | vm-agent | api), level (error | warn | info), message, stack, context (JSON), userId, nodeId, workspaceId, ipAddress, timestamp, createdAt.
- **LogQuery**: A parameterized query for the historical log viewer. Attributes: timeRange (start, end), levels (filter), search (text), limit, cursor.
- **HealthSummary**: An aggregated snapshot of platform health. Attributes: activeNodes, activeWorkspaces, inProgressTasks, errorCount24h, timestamp.
- **LogStreamConnection**: A real-time WebSocket connection from an admin. Attributes: adminUserId, filters (levels, search), connectedAt, status (connected | reconnecting | disconnected).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Admin can identify and read details of any platform error within 30 seconds of opening the observability dashboard.
- **SC-002**: Admin can view historical API Worker logs in-app without needing to access the Cloudflare dashboard, covering up to 7 days of history.
- **SC-003**: Real-time log entries appear in the admin stream within 5 seconds of the originating event.
- **SC-004**: The error list loads and displays the first page of results within 2 seconds for typical volumes (up to 10,000 stored errors).
- **SC-005**: The platform health summary refreshes and displays current counts within 3 seconds of page load.
- **SC-006**: All observability features are restricted to superadmin users; non-superadmin users cannot access any observability endpoints or UI sections.
- **SC-007**: The system gracefully handles Cloudflare API unavailability without crashing or exposing credentials, showing clear error messages to the admin.
- **SC-008**: Error trend visualization correctly reflects actual error distribution over time, verifiable by comparing against known error submissions.
- **SC-009**: Self-hosted deployments can use the full observability dashboard by configuring their own Cloudflare credentials, with no platform-specific dependencies.

## Scope Exclusions

- **Proactive alerting/notifications**: Webhook, email, or Slack notifications when error rates spike are explicitly out of scope for this feature. The admin monitors health via the dashboard and live stream. Alerting will be addressed in a future spec.
- **Per-user observability**: This feature is admin-only. Regular users continue to access their own node logs via the existing node observability (spec 020). No changes to user-facing log access.
- **Log export/download**: Bulk export of logs or errors to file is not included. Admins use the in-app viewer and can copy individual entries.

## Clarifications

### Session 2026-02-25

- Q: Should this feature include proactive alerting/notifications (webhook/email/Slack on error spikes), or is the dashboard + live stream sufficient? → A: Dashboard + live stream only; defer alerting to a future spec.
- Q: Should regular admin-role users also access the observability dashboard, or superadmin only? → A: Superadmin only (confirms FR-005 as written).
- Q: Should the API Worker also capture its own error-level logs into the observability DB alongside client and VM agent errors? → A: Yes, all three sources persisted to the observability DB for a unified error view.

## Assumptions

- **CF_API_TOKEN** and **CF_ACCOUNT_ID** are already available as platform secrets in the Cloudflare Worker environment. These are used to query the Observability API on behalf of the admin.
- The Cloudflare Workers Observability API (GA since Dec 2025) provides the historical log query capability and is available on the Workers Paid plan, which this platform already uses.
- Error storage (FR-001) will use a **separate D1 database** (e.g., `OBSERVABILITY_DB` binding) dedicated to observability data. This isolates error volume from the core platform database, allows independent purging/reset, and prevents error ingestion from affecting core query performance.
- The real-time log stream (FR-016) will use a Tail Worker forwarding to a Durable Object, which broadcasts to connected admin WebSocket clients. This is the Cloudflare-native approach for real-time log access.
- The existing node observability (spec 020) log viewer patterns and UI components can be reused or adapted for the admin log viewer.
- The existing admin page structure (`/admin` with superadmin gating) will be extended with a tab-based navigation to include the new observability sections alongside the existing user management.
