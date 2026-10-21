import * as v from 'valibot';

const packetSchema = v.object({
  id: v.string(),
  missionId: v.string(),
  fromTaskId: v.string(),
  artifactRefs: v.array(v.object({ type: v.string(), ref: v.string() })),
});

/** Incoming messages are not outputs. Validate only packets authored by this step. */
export function workflowOutputHandoffs(
  raw: unknown,
  runId: string,
  taskId: string,
  maxChars: number
) {
  const envelopes = v.parse(
    v.array(
      v.object({
        missionId: v.string(),
        fromTaskId: v.string(),
      })
    ),
    raw
  );
  const values = v.parse(v.array(v.unknown()), raw);
  const outputs = values.filter((_, index) => {
    const envelope = envelopes[index];
    return envelope?.missionId === runId && envelope.fromTaskId === taskId;
  });
  const handoffs: { id: string; artifactRefs: { type: string; ref: string }[] }[] = [];
  for (const value of outputs) {
    const parsed = v.safeParse(packetSchema, value);
    if (!parsed.success)
      return { error: 'Step published malformed artifact references', handoffs: [] };
    const packet = { id: parsed.output.id, artifactRefs: parsed.output.artifactRefs };
    if (JSON.stringify([...handoffs, packet]).length > maxChars) {
      // Keep the packet ID; the complete packet remains available via get_handoff.
      packet.artifactRefs = [];
      if (JSON.stringify([...handoffs, packet]).length > maxChars) break;
    }
    handoffs.push(packet);
  }
  return { error: null, handoffs };
}
