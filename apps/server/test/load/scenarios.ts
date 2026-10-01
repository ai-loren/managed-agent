/**
 * The load test's scenarios: each drives a real server the way a client would
 * and measures latency where that client sees it.
 */

import { hmacSha256Hex, randomToken } from '@ma/core';
import type { Receipt, SessionEvent } from '@ma/contracts';
import type { ManagedAgentClient } from '@ma/sdk';

import type { LiveServer } from '../support/live-server.ts';
import { Latencies, pool, type Summary } from './measure.ts';

export interface LoadContext {
  server: LiveServer;
  client: ManagedAgentClient;
  workspaceId: string;
  agentId: string;
}

export interface ScenarioResult {
  name: string;
  operations: Record<string, Summary>;
  /** Units of work finished per second of the scenario's wall time. */
  throughput: { unit: string; count: number; seconds: number };
  errors: number;
  /** The first few, to say what went wrong. */
  errorSamples: string[];
}

class Errors {
  count = 0;
  readonly samples: string[] = [];

  add(where: string, error: unknown): void {
    this.count++;
    if (this.samples.length < 5) this.samples.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const POLL_MS = 25;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, done: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await done())) {
    if (performance.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

/**
 * Follow a session's live events from `fromSeq`, handing each to `onEvent`.
 * Resolves once the stream is open; reads until `signal` aborts.
 */
async function follow(server: LiveServer, sessionId: string, fromSeq: number, onEvent: (event: SessionEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${server.baseUrl}/v1/sessions/${sessionId}/events/stream?fromSeq=${fromSeq}`, {
    headers: { authorization: `Bearer ${server.token}`, accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`the event stream answered ${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  void (async () => {
    let buffered = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffered += value;
        for (let end = buffered.indexOf('\n\n'); end >= 0; end = buffered.indexOf('\n\n')) {
          const data = buffered
            .slice(0, end)
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          buffered = buffered.slice(end + 2);
          if (!data) continue;
          const event = JSON.parse(data) as Partial<SessionEvent>;
          if (typeof event.seq === 'number' && typeof event.type === 'string') onEvent(event as SessionEvent);
        }
      }
    } catch {
      // Aborted: the scenario is done with it.
    }
  })();
}

const reply = (event: SessionEvent): string | undefined => {
  const payload = event.payload as { role?: unknown; text?: unknown };
  return event.type === 'message.completed' && payload.role === 'assistant' ? String(payload.text) : undefined;
};

async function readySession(context: LoadContext, title: string): Promise<string> {
  const { session } = await context.client.createSession({ agentId: context.agentId, title });
  await until(`session ${session.id} to be ready`, async () => (await context.client.getSession(session.id)).session.status === 'ready', 120_000);
  return session.id;
}

async function lastSeq(context: LoadContext, sessionId: string): Promise<number> {
  return (await context.client.readEvents(sessionId, { limit: 1, order: 'desc' })).lastSeq;
}

/** The control plane's request path: reads and writes that touch the store and nothing else. */
export async function api(context: LoadContext, options: { requests: number; concurrency: number }): Promise<ScenarioResult> {
  const { client, workspaceId } = context;
  const operations: Record<string, () => Promise<unknown>> = {
    'GET /v1/workspaces/:id': () => client.getWorkspace(workspaceId),
    'GET /v1/agents': () => client.listAgents(workspaceId, { limit: 20 }),
    'GET /v1/sessions': () => client.listSessions({ workspaceId, limit: 20 }),
    'GET /v1/workspaces/:id/quota': () => client.getQuota(workspaceId),
    'POST /v1/agents': () => client.createAgent(workspaceId, { name: `load ${randomToken(6)}` }),
  };
  const names = Object.keys(operations);
  const latencies = new Map(names.map((name) => [name, new Latencies()]));
  const errors = new Errors();
  const started = performance.now();
  await pool(options.requests, options.concurrency, async (index) => {
    const name = names[index % names.length]!;
    const before = performance.now();
    try {
      await operations[name]!();
      latencies.get(name)!.record(performance.now() - before);
    } catch (error) {
      errors.add(name, error);
    }
  });
  return {
    name: 'api',
    operations: Object.fromEntries([...latencies].map(([name, recorded]) => [name, recorded.summary()])),
    throughput: { unit: 'requests', count: options.requests - errors.count, seconds: (performance.now() - started) / 1000 },
    errors: errors.count,
    errorSamples: errors.samples,
  };
}

/** Sessions side by side, each a sandbox of its own taking turns one after another. */
export async function turns(context: LoadContext, options: { sessions: number; turns: number }): Promise<ScenarioResult> {
  const ready = new Latencies();
  const turn = new Latencies();
  const errors = new Errors();
  let completed = 0;
  const started = performance.now();
  await pool(options.sessions, options.sessions, async (index) => {
    const stop = new AbortController();
    let sessionId: string | undefined;
    try {
      const before = performance.now();
      sessionId = await readySession(context, `load turns ${index}`);
      ready.record(performance.now() - before);
      const replies = new Set<string>();
      await follow(context.server, sessionId, (await lastSeq(context, sessionId)) + 1, (event) => {
        const text = reply(event);
        if (text !== undefined) replies.add(text);
      }, stop.signal);
      for (let round = 0; round < options.turns; round++) {
        const text = `turn ${index}.${round} ${randomToken(4)}`;
        const sent = performance.now();
        await context.client.prompt(sessionId, text);
        await until(`the reply to ${text}`, () => replies.has(`echo: ${text}`), 60_000);
        turn.record(performance.now() - sent);
        completed++;
      }
    } catch (error) {
      errors.add(`session ${index}`, error);
    } finally {
      stop.abort();
      if (sessionId) await context.client.terminate(sessionId, 'load test done').catch(() => undefined);
    }
  });
  return {
    name: 'turns',
    operations: { 'session ready': ready.summary(), 'turn (prompt to reply)': turn.summary() },
    throughput: { unit: 'turns', count: completed, seconds: (performance.now() - started) / 1000 },
    errors: errors.count,
    errorSamples: errors.samples,
  };
}

/** Signed webhook deliveries arriving at once, through to each agent's reply. */
export async function webhooks(
  context: LoadContext,
  options: { deliveries: number; concurrency: number; conversations: number },
): Promise<ScenarioResult> {
  const { client, server, workspaceId } = context;
  const secret = `load-hook-${randomToken(12)}`;
  const { credential } = await client.createCredential(workspaceId, { ownerType: 'workspace', type: 'api_key', name: 'load hook secret', value: secret });
  const connector = await client.createConnector(workspaceId, {
    type: 'webhook',
    name: 'load hook',
    externalKey: `load-${randomToken(6).toLowerCase()}`,
    agentId: context.agentId,
    sessionPolicy: 'reuse_per_scope',
    secretCredentialId: credential.id,
    config: {},
  });
  await client.activateConnector(connector.id);

  const ingress = new Latencies();
  const errors = new Errors();
  const started = performance.now();
  await pool(options.deliveries, options.concurrency, async (index) => {
    const body = JSON.stringify({ prompt: `hook ${index}`, eventId: `load-${index}`, scope: `conversation ${index % options.conversations}` });
    const timestamp = Date.now();
    const before = performance.now();
    try {
      const response = await fetch(`${server.baseUrl}/ingress/v1/${workspaceId}/${connector.externalKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ma-timestamp': String(timestamp), 'x-ma-signature': hmacSha256Hex(secret, `${timestamp}.${body}`) },
        body,
      });
      const text = await response.text();
      if (response.status !== 202) throw new Error(`ingress answered ${response.status}: ${text.slice(0, 200)}`);
      ingress.record(performance.now() - before);
    } catch (error) {
      errors.add('ingress', error);
    }
  });

  const receipts = async (): Promise<Receipt[]> => {
    const all: Receipt[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listReceipts(connector.id, { limit: 200, ...(cursor ? { cursor } : {}) });
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  };
  const accepted = options.deliveries - errors.count;
  let settled: Receipt[] = [];
  try {
    await until('every delivery to finish', async () => {
      settled = (await receipts()).filter((receipt) => receipt.status === 'succeeded' || receipt.status === 'failed');
      return settled.length >= accepted;
    }, 300_000);
  } catch (error) {
    errors.add('deliveries', error);
  }
  const delivery = new Latencies();
  for (const receipt of settled) {
    if (receipt.status === 'failed') errors.add(`receipt ${receipt.id}`, receipt.error?.message ?? 'failed');
    else if (receipt.completedAt !== undefined) delivery.record(receipt.completedAt - receipt.createdAt);
  }
  return {
    name: 'webhooks',
    operations: { 'ingress (POST to 202)': ingress.summary(), 'delivery (accepted to reply)': delivery.summary() },
    throughput: { unit: 'deliveries', count: settled.filter((receipt) => receipt.status === 'succeeded').length, seconds: (performance.now() - started) / 1000 },
    errors: errors.count,
    errorSamples: errors.samples,
  };
}

/** One session's events reaching many live subscribers. */
export async function stream(context: LoadContext, options: { subscribers: number; turns: number }): Promise<ScenarioResult> {
  const errors = new Errors();
  const fanout = new Latencies();
  const stop = new AbortController();
  let sessionId: string | undefined;
  let delivered = 0;
  const started = performance.now();
  try {
    sessionId = await readySession(context, 'load stream');
    const from = (await lastSeq(context, sessionId)) + 1;
    const seen = Array.from({ length: options.subscribers }, () => new Set<number>());
    const replies = Array.from({ length: options.subscribers }, () => new Set<string>());
    await Promise.all(
      seen.map((seqs, index) =>
        follow(context.server, sessionId!, from, (event) => {
          fanout.record(Date.now() - event.ts);
          seqs.add(event.seq);
          const text = reply(event);
          if (text !== undefined) replies[index]!.add(text);
          delivered++;
        }, stop.signal),
      ),
    );
    for (let round = 0; round < options.turns; round++) {
      const text = `stream ${round} ${randomToken(4)}`;
      await context.client.prompt(sessionId, text);
      await until(`every subscriber to see the reply to ${text}`, () => replies.every((set) => set.has(`echo: ${text}`)), 60_000);
    }
    const last = await lastSeq(context, sessionId);
    await until('every subscriber to see every event', () => seen.every((seqs) => seqs.size === last - from + 1), 10_000).catch((error: unknown) => {
      errors.add('fan-out', `${String(error)}; subscribers saw ${[...new Set(seen.map((seqs) => seqs.size))].join(' or ')} of ${last - from + 1} events`);
    });
  } catch (error) {
    errors.add('stream', error);
  } finally {
    stop.abort();
    if (sessionId) await context.client.terminate(sessionId, 'load test done').catch(() => undefined);
  }
  return {
    name: 'stream',
    operations: { 'event to subscriber': fanout.summary() },
    throughput: { unit: 'events delivered', count: delivered, seconds: (performance.now() - started) / 1000 },
    errors: errors.count,
    errorSamples: errors.samples,
  };
}
