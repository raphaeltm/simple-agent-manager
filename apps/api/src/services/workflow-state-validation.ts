import * as v from 'valibot';

const attribution = v.object({
  userId: v.string(),
  projectId: v.nullable(v.string()),
  source: v.picklist(['user', 'project', 'platform', 'self-hosted']),
});
export function workflowSnapshot(json: string) {
  return v.parse(
    v.object({
      dispatchDepth: v.number(),
      projectSnapshotJson: v.string(),
      credentialAttribution: attribution,
    }),
    JSON.parse(json)
  );
}
export function workflowDependencies(json: string) {
  return v.parse(v.array(v.string()), JSON.parse(json));
}
export function workflowResult(json: string) {
  return v.parse(
    v.object({
      summary: v.optional(v.string()),
      branch: v.optional(v.nullable(v.string())),
      prUrl: v.optional(v.nullable(v.string())),
      handoffs: v.optional(
        v.array(
          v.object({
            id: v.string(),
            artifactRefs: v.array(v.object({ type: v.string(), ref: v.string() })),
          })
        ),
        []
      ),
    }),
    JSON.parse(json)
  );
}
export function workflowSubmission(json: string) {
  return v.parse(
    v.object({
      identities: v.object({
        taskId: v.string(),
        chatSessionId: v.string(),
        initialMessageId: v.string(),
        initialStatusEventId: v.string(),
      }),
      projectId: v.string(),
      userId: v.string(),
      prompt: v.string(),
      branchNameSeed: v.string(),
      agentProfileId: v.string(),
      skillId: v.null(),
      taskMode: v.literal('task'),
      vmSizeOverride: v.null(),
      source: v.object({
        kind: v.literal('workflow'),
        sourceId: v.string(),
        sourceExecutionId: v.string(),
        triggeredBy: v.literal('mcp'),
        displayName: v.string(),
        repositoryAccessFlow: v.string(),
        initialStatusReason: v.string(),
        initialStatusActorType: v.literal('system'),
        initialStatusActorId: v.null(),
        expiresAt: v.number(),
      }),
      workflow: v.object({
        missionId: v.string(),
        stepKey: v.string(),
        expectedProfileJson: v.string(),
        expectedProjectJson: v.string(),
        parentTaskId: v.string(),
        dispatchDepth: v.number(),
        maxPerTask: v.number(),
        maxActivePerProject: v.number(),
        credentialAttribution: attribution,
      }),
    }),
    JSON.parse(json)
  );
}
