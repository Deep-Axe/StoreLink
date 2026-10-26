// Tool-call metrics derived from the audit log, plus Prometheus text exposition.

// Upper bounds (ms) of the latency histogram buckets; the gateway call deadline is 15 s.
export const latencyBucketsMs = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 15000,
] as const;

const completedOutcomes = `('success','failed','timeout','uncertain')`;

export type CallStatsFilter = { teamId?: string; since?: Date };

export type ServerCallStats = {
  teamId: string;
  serverId: string;
  success: number;
  failed: number;
  timeout: number;
  uncertain: number;
  denied: number;
  durationSumMs: number;
  // Cumulative counts of completed calls at or below each latencyBucketsMs bound.
  buckets: number[];
};

export type ServerCallSummary = {
  calls: number;
  errors: number;
  timeouts: number;
  denied: number;
  errorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
};

export type UpstreamState = {
  id: string;
  teamId: string;
  slug: string;
  status: string;
  lastFailureAt?: string;
};

// One query for both PostgreSQL ($n placeholders) and SQLite (? placeholders).
export function callStatsQuery(
  style: 'postgres' | 'sqlite',
  filter: CallStatsFilter,
): { text: string; values: string[] } {
  const values: string[] = [];
  const param = (value: string) => {
    values.push(value);
    return style === 'postgres' ? `$${values.length}` : '?';
  };
  const where = ['server_id IS NOT NULL', `outcome <> 'started'`];
  if (filter.teamId) where.push(`team_id = ${param(filter.teamId)}`);
  if (filter.since)
    where.push(`timestamp >= ${param(filter.since.toISOString())}`);
  const count = (condition: string) =>
    `SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END)`;
  const buckets = latencyBucketsMs.map(
    (bound, index) =>
      `${count(`outcome IN ${completedOutcomes} AND duration_ms <= ${bound}`)} AS le_${index}`,
  );
  return {
    text: `SELECT team_id, server_id,
      ${count(`outcome = 'success'`)} AS success,
      ${count(`outcome = 'failed'`)} AS failed,
      ${count(`outcome = 'timeout'`)} AS timeout,
      ${count(`outcome = 'uncertain'`)} AS uncertain,
      ${count(`outcome = 'denied'`)} AS denied,
      SUM(CASE WHEN outcome IN ${completedOutcomes} THEN duration_ms ELSE 0 END) AS duration_sum,
      ${buckets.join(',\n      ')}
    FROM audit_calls
    WHERE ${where.join(' AND ')}
    GROUP BY team_id, server_id
    ORDER BY team_id, server_id`,
    values,
  };
}

export function parseCallStats(
  rows: Record<string, unknown>[],
): ServerCallStats[] {
  const number = (value: unknown) => Number(value ?? 0);
  return rows.map((row) => ({
    teamId: String(row.team_id ?? ''),
    serverId: String(row.server_id),
    success: number(row.success),
    failed: number(row.failed),
    timeout: number(row.timeout),
    uncertain: number(row.uncertain),
    denied: number(row.denied),
    durationSumMs: number(row.duration_sum),
    buckets: latencyBucketsMs.map((_, index) => number(row[`le_${index}`])),
  }));
}

const completed = (stats: ServerCallStats) =>
  stats.success + stats.failed + stats.timeout + stats.uncertain;

// Linear interpolation inside the matching bucket, as Prometheus histogram_quantile does.
export function estimateQuantile(
  quantile: number,
  buckets: number[],
  total: number,
): number {
  if (total === 0) return 0;
  const rank = quantile * total;
  for (let index = 0; index < buckets.length; index++) {
    if (buckets[index] >= rank) {
      const lower = index === 0 ? 0 : latencyBucketsMs[index - 1];
      const below = index === 0 ? 0 : buckets[index - 1];
      const inBucket = buckets[index] - below;
      const fraction = inBucket === 0 ? 1 : (rank - below) / inBucket;
      return Math.round(lower + (latencyBucketsMs[index] - lower) * fraction);
    }
  }
  return latencyBucketsMs[latencyBucketsMs.length - 1];
}

export function summarizeCalls(stats?: ServerCallStats): ServerCallSummary {
  if (!stats)
    return {
      calls: 0,
      errors: 0,
      timeouts: 0,
      denied: 0,
      errorRate: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
    };
  const calls = completed(stats);
  const errors = stats.failed + stats.timeout + stats.uncertain;
  return {
    calls,
    errors,
    timeouts: stats.timeout,
    denied: stats.denied,
    errorRate: calls ? Math.round((errors / calls) * 1000) / 10 : 0,
    avgLatencyMs: calls ? Math.round(stats.durationSumMs / calls) : 0,
    p95LatencyMs: estimateQuantile(0.95, stats.buckets, calls),
  };
}

const escapeLabel = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labels = (pairs: Record<string, string>) =>
  `{${Object.entries(pairs)
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(',')}}`;

export function renderPrometheus(
  stats: ServerCallStats[],
  upstreams: UpstreamState[],
): string {
  const slugs = new Map(upstreams.map((u) => [`${u.teamId}:${u.id}`, u.slug]));
  const series = (s: ServerCallStats) => ({
    team: s.teamId,
    server: s.serverId,
    slug: slugs.get(`${s.teamId}:${s.serverId}`) ?? s.serverId,
  });
  const lines: string[] = [];
  const metric = (name: string, type: string, help: string) =>
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);

  metric(
    'storelink_tool_calls_total',
    'counter',
    'Tool calls routed to an upstream, by outcome.',
  );
  for (const s of stats)
    for (const outcome of [
      'success',
      'failed',
      'timeout',
      'uncertain',
      'denied',
    ] as const)
      lines.push(
        `storelink_tool_calls_total${labels({ ...series(s), outcome })} ${s[outcome]}`,
      );

  metric(
    'storelink_tool_call_duration_seconds',
    'histogram',
    'Duration of completed tool calls.',
  );
  for (const s of stats) {
    const base = series(s);
    latencyBucketsMs.forEach((bound, index) =>
      lines.push(
        `storelink_tool_call_duration_seconds_bucket${labels({ ...base, le: String(bound / 1000) })} ${s.buckets[index]}`,
      ),
    );
    lines.push(
      `storelink_tool_call_duration_seconds_bucket${labels({ ...base, le: '+Inf' })} ${completed(s)}`,
      `storelink_tool_call_duration_seconds_sum${labels(base)} ${s.durationSumMs / 1000}`,
      `storelink_tool_call_duration_seconds_count${labels(base)} ${completed(s)}`,
    );
  }

  metric(
    'storelink_upstream_up',
    'gauge',
    'Whether the upstream is connected (1) or not (0).',
  );
  for (const u of upstreams)
    lines.push(
      `storelink_upstream_up${labels({ team: u.teamId, server: u.id, slug: u.slug })} ${u.status === 'Connected' ? 1 : 0}`,
    );

  metric(
    'storelink_upstream_status',
    'gauge',
    'Current upstream status; the matching status label is 1.',
  );
  for (const u of upstreams)
    for (const status of ['Connected', 'Unreachable', 'Disabled'])
      lines.push(
        `storelink_upstream_status${labels({ team: u.teamId, server: u.id, slug: u.slug, status })} ${u.status === status ? 1 : 0}`,
      );

  metric(
    'storelink_upstream_last_failure_timestamp_seconds',
    'gauge',
    'Unix time of the most recent upstream failure.',
  );
  for (const u of upstreams)
    if (u.lastFailureAt)
      lines.push(
        `storelink_upstream_last_failure_timestamp_seconds${labels({ team: u.teamId, server: u.id, slug: u.slug })} ${Math.floor(Date.parse(u.lastFailureAt) / 1000)}`,
      );

  return `${lines.join('\n')}\n`;
}
