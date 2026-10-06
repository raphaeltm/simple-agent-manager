import * as v from 'valibot';

/**
 * Project file library request schemas (apps/api/src/routes/library.ts).
 *
 * Both schemas mirror the shared `MoveFileRequest`/`UpdateTagsRequest`
 * shapes exactly (plain optional string / string array fields, no
 * null/unknown widening) because the route passes the parsed body straight
 * through to the service layer (`moveFile(..., body)`,
 * `updateTags(..., body)`), whose parameters are declared with those exact
 * types — a looser schema type would fail to structurally satisfy them.
 */

export const MoveFileSchema = v.object({
  directory: v.optional(v.string()),
  filename: v.optional(v.string()),
});

export const UpdateTagsSchema = v.object({
  add: v.optional(v.array(v.string())),
  remove: v.optional(v.array(v.string())),
});
