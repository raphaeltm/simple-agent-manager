/** Fixed read-only release evidence through existing deployment credentials. */
export async function readStorageEvidence({ api, worker, workspaceId, rateIdentity }) {
  for (const id of [workspaceId, rateIdentity]) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id ?? ''))
      throw new Error('Exact release fixture IDs required');
  }
  const namespaces = [];
  // Cloudflare's namespace list allows 1000 items per page. Fail rather than scan unboundedly.
  for (let page = 1; page <= 10; page++) {
    const rows = await api(`/workers/durable_objects/namespaces?page=${page}&per_page=1000`);
    if (!Array.isArray(rows)) throw new Error('Invalid namespace list');
    namespaces.push(...rows);
    if (rows.length < 1000) break;
    if (page === 10) throw new Error('Namespace list exceeds bounded release verification');
  }
  const select = async (className, name, queries, columns) => {
    const matches = namespaces.filter(
      (n) => n.script === worker && n.class === className && n.use_sqlite === true
    );
    if (matches.length !== 1) throw new Error(`Expected one compatible ${className} namespace`);
    const result = await api(
      `/workers/durable_objects/namespaces/${encodeURIComponent(matches[0].id)}/query/v2`,
      {
        durable_object_name: name,
        jurisdiction: 'none',
        queries: queries.map((sql) => ({ sql })),
      }
    );
    if (
      result?.error ||
      !Array.isArray(result?.results) ||
      result.results.length !== columns.length
    )
      throw new Error('DO verification query failed');
    return result.results.map((r, i) => {
      if (
        r.meta?.rows_written !== 0 ||
        JSON.stringify(r.columns) !== JSON.stringify(columns[i]) ||
        !Array.isArray(r.rows) ||
        r.rows.some((row) => !Array.isArray(row) || row.length !== columns[i].length)
      )
        throw new Error('Unexpected DO verification result');
      return r.rows;
    });
  };
  const [logs, state] = await select(
    'WorkspaceBootLog',
    workspaceId,
    [
      "SELECT COUNT(*) AS count, MIN(json_extract(payload, '$.timestamp')) AS oldest, MAX(json_extract(payload, '$.timestamp')) AS newest FROM entries",
      'SELECT expires_at, allow_legacy FROM log_state WHERE id = 1',
    ],
    [
      ['count', 'oldest', 'newest'],
      ['expires_at', 'allow_legacy'],
    ]
  );
  if (
    logs.length !== 1 ||
    !Number.isSafeInteger(logs[0][0]) ||
    logs[0][0] < 0 ||
    state.length > 1 ||
    logs[0]
      .slice(1)
      .some(
        (x) =>
          x !== null &&
          (typeof x !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(x) ||
            !Number.isFinite(Date.parse(x)))
      ) ||
    state.some((r) => !Number.isSafeInteger(r[0]) || ![0, 1].includes(r[1]))
  )
    throw new Error('Invalid log verification values');
  const [counters] = await select(
    'McpRateCounter',
    rateIdentity,
    ['SELECT window_start, reset_at, count FROM counters ORDER BY window_start DESC LIMIT 4'],
    [['window_start', 'reset_at', 'count']]
  );
  if (
    counters.length > 4 ||
    counters.some((r) => r.some((x) => !Number.isSafeInteger(x) || x < 0) || r[1] <= r[0])
  )
    throw new Error('Invalid counter verification values');
  return {
    workspaceId,
    rateIdentity,
    logCount: logs[0][0],
    oldest: logs[0][1],
    newest: logs[0][2],
    logState: state.map(([expiresAt, allowLegacy]) => ({ expiresAt, allowLegacy })),
    counters: counters.map(([windowStart, resetAt, count]) => ({ windowStart, resetAt, count })),
    queryRowsWritten: 0,
  };
}
