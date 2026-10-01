#!/usr/bin/env node
/**
 * A reference command runtime for Managed-Agent.
 *
 * This is a complete, dependency-free agent runtime that runs in a sandbox and
 * drives a turn entirely over the `/runtime/v1/*` bridge protocol — the same
 * contract the platform's built-in harness uses. An agent version that declares
 *
 *   runtime: { type: 'command', command: 'node', args: ['echo-runtime.mjs'] }
 *
 * gets this loop instead of the built-in one. It is intentionally minimal (echo
 * one model turn) so it reads as documentation of the protocol; a real runtime
 * in any language does the same four things:
 *
 *   1. Read the prompt from stdin.
 *   2. GET  {MA_RUNTIME_URL}/bootstrap        — its pinned config (model id, etc).
 *   3. POST {MA_RUNTIME_URL}/completions       — model access (no provider key here).
 *   4. POST {MA_RUNTIME_URL}/events            — its own turn/message events.
 *
 * Everything authenticates with the bearer token in MA_RUNTIME_TOKEN. The token
 * is session-scoped: the bridge resolves which session these calls belong to, so
 * a runtime can only ever write to its own session.
 */

const BASE = process.env.MA_RUNTIME_URL;
const TOKEN = process.env.MA_RUNTIME_TOKEN;

if (!BASE || !TOKEN) {
  process.stderr.write('MA_RUNTIME_URL and MA_RUNTIME_TOKEN must be set by the sandbox\n');
  process.exit(1);
}

/** One authenticated call to the bridge. */
async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.status === 204 ? undefined : response.json();
}

/** Read all of stdin as the prompt. */
async function readPrompt() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const prompt = await readPrompt();
  const boot = await call('/bootstrap');
  // A prewarmed sandbox may boot unbound; a command runtime is only spawned for a
  // real turn, so this should not happen, but fail cleanly if it does.
  if (boot.unbound) {
    process.stderr.write('runtime started with no session bound\n');
    process.exit(1);
  }

  const turn = 1;
  // Echo the submission this turn runs, so whoever submitted it can tell this
  // turn from others on the same session.
  const submission = process.env.MA_SUBMISSION_ID ? { submissionId: process.env.MA_SUBMISSION_ID } : {};
  await call('/events', {
    method: 'POST',
    body: {
      events: [{ type: 'turn.started', turn, payload: { turn, promptPreview: prompt.slice(0, 200), ...submission } }],
    },
  });

  const startedAt = Date.now();
  const completion = await call('/completions', {
    method: 'POST',
    body: {
      modelId: boot.model.modelId,
      turn,
      messages: [
        { role: 'system', content: boot.systemPrompt ?? '' },
        { role: 'user', content: prompt },
      ],
      tools: [],
    },
  });

  await call('/events', {
    method: 'POST',
    body: {
      events: [
        {
          type: 'message.completed',
          turn,
          payload: { role: 'assistant', text: completion.text ?? '' },
        },
        {
          type: 'turn.completed',
          turn,
          payload: {
            turn,
            reason: 'completed',
            durationMs: Date.now() - startedAt,
            usage: completion.usage ?? {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costMicros: 0,
            },
          },
        },
      ],
    },
  });
}

main().catch((error) => {
  process.stderr.write(`runtime turn failed: ${error?.message ?? String(error)}\n`);
  process.exit(1);
});
