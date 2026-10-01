/**
 * Load tests: a real server under concurrent traffic — control-plane requests,
 * sessions taking turns side by side, a burst of signed webhooks through to the
 * agents' replies, and one session's events fanned out to many subscribers —
 * with latency measured where a client sees it.
 *
 *   pnpm load                      # the full profile
 *   pnpm load --profile smoke      # small enough for CI
 *   pnpm load --only api,stream    # some scenarios
 *   pnpm load --json report.json   # the numbers, for a dashboard or a diff
 *
 * The server runs as its own process on the local sandbox driver, every session
 * a real agent-core; the model answers at once, so the numbers are the
 * platform's own and not a provider's. MA_LOAD_DATABASE=postgres://… runs it on
 * Postgres. It exits non-zero on any error or on a latency past the profile's
 * limit; the limits are set well above what a laptop measures, to catch a
 * regression of an order of magnitude rather than to benchmark a machine.
 */

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { EchoModel, LiveServer, MODEL } from '../support/live-server.ts';
import { api, stream, turns, webhooks, type LoadContext, type ScenarioResult } from './scenarios.ts';

interface Profile {
  api: { requests: number; concurrency: number };
  turns: { sessions: number; turns: number };
  webhooks: { deliveries: number; concurrency: number; conversations: number };
  stream: { subscribers: number; turns: number };
  /** p99 ceilings in milliseconds, by `scenario: operation`. */
  limits: Record<string, number>;
}

const PROFILES: Record<string, Profile> = {
  smoke: {
    api: { requests: 300, concurrency: 8 },
    turns: { sessions: 3, turns: 2 },
    webhooks: { deliveries: 30, concurrency: 8, conversations: 3 },
    stream: { subscribers: 8, turns: 2 },
    limits: {
      'api: GET /v1/workspaces/:id': 1_000,
      'api: POST /v1/agents': 1_000,
      'turns: turn (prompt to reply)': 20_000,
      'webhooks: ingress (POST to 202)': 2_000,
      'stream: event to subscriber': 2_000,
    },
  },
  full: {
    api: { requests: 5_000, concurrency: 32 },
    turns: { sessions: 16, turns: 5 },
    webhooks: { deliveries: 400, concurrency: 32, conversations: 16 },
    stream: { subscribers: 64, turns: 5 },
    limits: {
      'api: GET /v1/workspaces/:id': 500,
      'api: POST /v1/agents': 500,
      'turns: turn (prompt to reply)': 10_000,
      'webhooks: ingress (POST to 202)': 1_000,
      'stream: event to subscriber': 1_000,
    },
  },
};

const SCENARIOS = { api, turns, webhooks, stream } as const;
type ScenarioName = keyof typeof SCENARIOS;

const { values } = parseArgs({
  options: {
    profile: { type: 'string', default: 'full' },
    only: { type: 'string' },
    json: { type: 'string' },
  },
});
const profile = PROFILES[values.profile];
if (!profile) {
  console.error(`Unknown profile ${JSON.stringify(values.profile)}; expected one of: ${Object.keys(PROFILES).join(', ')}.`);
  process.exit(2);
}
const selected = (values.only?.split(',').map((name) => name.trim()) ?? Object.keys(SCENARIOS)) as ScenarioName[];
const unknown = selected.filter((name) => !(name in SCENARIOS));
if (unknown.length > 0) {
  console.error(`Unknown scenario ${unknown.join(', ')}; expected some of: ${Object.keys(SCENARIOS).join(', ')}.`);
  process.exit(2);
}

const model = new EchoModel();
await model.start();
const server = new LiveServer(model, {
  MA_LOG_LEVEL: 'warn',
  ...(process.env.MA_LOAD_DATABASE ? { MA_DATABASE: process.env.MA_LOAD_DATABASE } : {}),
});
const results: ScenarioResult[] = [];
let failed = false;
try {
  await server.start();
  const { workspace } = await server.client.createWorkspace({ name: 'Load', slug: `load-${Date.now().toString(36)}` });
  // The defaults (twenty sessions, twenty sandboxes) are a tenant's budget, not the platform's limit.
  await server.client.updateQuota(workspace.id, { maxConcurrentSessions: 1_000, maxSandboxes: 1_000, maxAgents: 100_000 });
  const { agent } = await server.client.createAgent(workspace.id, {
    name: 'Echo',
    spec: { systemPrompt: 'Echo the request.', model: { modelId: MODEL } },
  });
  const context: LoadContext = { server, client: server.client, workspaceId: workspace.id, agentId: agent.id };

  for (const name of selected) {
    const started = performance.now();
    process.stderr.write(`${name}: running…\n`);
    const result = await (SCENARIOS[name] as (context: LoadContext, options: never) => Promise<ScenarioResult>)(context, profile[name] as never);
    results.push(result);
    process.stderr.write(`${name}: done in ${((performance.now() - started) / 1000).toFixed(1)} s\n`);
  }
} catch (error) {
  failed = true;
  console.error(`The load test could not run: ${error instanceof Error ? error.message : String(error)}\n${server.log.slice(-4000)}`);
} finally {
  await server.dispose();
  await model.stop();
}

const breaches: string[] = [];
const rows: string[][] = [['scenario: operation', 'count', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms']];
for (const result of results) {
  for (const [operation, summary] of Object.entries(result.operations)) {
    const key = `${result.name}: ${operation}`;
    rows.push([key, String(summary.count), ...[summary.p50, summary.p95, summary.p99, summary.max].map((ms) => ms.toFixed(1))]);
    const limit = profile.limits[key];
    if (limit !== undefined && summary.p99 > limit) breaches.push(`${key}: p99 ${summary.p99.toFixed(1)} ms is past its limit of ${limit} ms`);
  }
  if (result.errors > 0) breaches.push(`${result.name}: ${result.errors} errors, e.g. ${result.errorSamples.join(' | ')}`);
}
const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
console.log(`\nprofile ${values.profile}, ${process.env.MA_LOAD_DATABASE ? 'Postgres' : 'SQLite'}\n`);
for (const row of rows) console.log(row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join('  '));
console.log('');
for (const result of results) {
  const { unit, count, seconds } = result.throughput;
  console.log(`${result.name}: ${count} ${unit} in ${seconds.toFixed(1)} s, ${(count / seconds).toFixed(1)}/s`);
}
if (values.json) writeFileSync(values.json, `${JSON.stringify({ profile: values.profile, results, breaches }, null, 2)}\n`);
if (breaches.length > 0) {
  console.log(`\n${breaches.length} past what the profile allows:\n${breaches.map((line) => `  ${line}`).join('\n')}`);
  failed = true;
}
process.exit(failed ? 1 : 0);
