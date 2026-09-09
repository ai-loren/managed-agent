/**
 * The Managed-Agent client.
 *
 * Built on `fetch`, so the same code runs in a browser, in Node, and in a
 * sandbox — no transport abstraction, no polyfill.
 *
 * Two behaviours are the client's responsibility rather than the caller's:
 *
 *  - **Retries are safe by construction.** Only idempotent requests are
 *    retried automatically, and any mutation the caller wants retried gets an
 *    idempotency key so the server can deduplicate it. A blind retry of a
 *    session create is how one request becomes two agent runs.
 *  - **Streaming resumes itself.** `streamEvents` tracks the last sequence it
 *    saw and reconnects from there, so a dropped connection is invisible to
 *    the caller.
 */

import {
  MaError,
  backoffDelay,
  randomToken,
  systemClock,
  type Clock,
  type RetryPolicy,
} from '@ma/core';
import { isStreamEvent } from '@ma/contracts';
import type {
  Agent,
  Artifact,
  AgentVersion,
  AgentTemplate,
  Credential,
  Model,
  Memory,
  Session,
  SessionEvent,
  SessionStatus,
  TemplateVariable,
  UniversalEvent,
  Workspace,
  WorkspaceRole,
} from '@ma/contracts';

export interface ClientOptions {
  baseUrl: string;
  /** API token. Sent as a bearer credential. */
  token: string;
  /**
   * Drives retry backoff. Injected so a test can advance it rather than wait.
   *
   * Deliberately not used for the per-request deadline: a timeout measures how
   * long the *network* has taken, which a test clock cannot know, and wiring it
   * here would make every request hang until a test happened to advance time.
   */
  clock?: Clock;
  /** Overrides `fetch`, for tests and for hosts with a custom agent. */
  fetch?: typeof globalThis.fetch;
  retry?: Partial<RetryPolicy>;
  /** Per-request timeout. */
  timeoutMs?: number;
  /**
   * Longest the client will sleep on a server's Retry-After hint. A hint
   * beyond this surfaces the error instead, so a caller is never silently
   * blocked for the length of a daily quota window.
   */
  maxRetryDelayMs?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface PageRequest {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

/** Query values are stringified; `undefined` entries are dropped. */
type QueryParams = Readonly<Record<string, string | number | boolean | undefined>>;

interface RequestOptions {
  method?: string;
  body?: unknown;
  /**
   * Accepts any object: interface types lack an index signature, so a narrower
   * parameter would reject every filter type the methods below already define.
   */
  query?: QueryParams | object;
  /** Supplied for mutations the caller wants safely retryable. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * Marks an error whose retry decision has already been made, so the transport
 * catch re-raises it rather than applying its own policy on top.
 */
const FINAL = Symbol('ma.final');

function finalize(error: MaError): MaError {
  (error as unknown as Record<symbol, boolean>)[FINAL] = true;
  return error;
}

function isFinal(error: unknown): error is MaError {
  return MaError.is(error) && (error as unknown as Record<symbol, boolean>)[FINAL] === true;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Beyond this, waiting out a Retry-After is the caller's decision, not ours. */
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;

export class ManagedAgentClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #clock: Clock;
  readonly #fetch: typeof globalThis.fetch;
  readonly #retry: RetryPolicy;
  readonly #timeoutMs: number;
  readonly #maxRetryDelayMs: number;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#clock = options.clock ?? systemClock;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.#retry = {
      maxAttempts: 3,
      initialDelayMs: 250,
      maxDelayMs: 5000,
      multiplier: 2,
      jitter: true,
      ...options.retry,
    };
  }

  // --- transport -----------------------------------------------------------

  async #request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const url = new URL(this.#baseUrl + path);
    for (const [key, value] of Object.entries((options.query ?? {}) as QueryParams)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      accept: 'application/json',
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    // A request is safe to retry when it is read-only, or when the caller gave
    // it an idempotency key so the server will deduplicate a duplicate arrival.
    const retryable = method === 'GET' || method === 'HEAD' || Boolean(options.idempotencyKey);
    const attempts = retryable ? this.#retry.maxAttempts : 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const timeout = new AbortController();
      const onAbort = (): void => timeout.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      // Real time, for the reason given on `clock` above.
      const deadline = AbortSignal.timeout(this.#timeoutMs);
      deadline.addEventListener('abort', onAbort, { once: true });

      try {
        const response = await this.#fetch(url.toString(), {
          method,
          headers,
          signal: timeout.signal,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });

        if (response.ok) {
          if (response.status === 204) return undefined as T;
          return (await response.json()) as T;
        }

        const error = await this.#toError(response);
        // Only the server's own judgement decides retryability, so a 400 is
        // never retried and a 429 waits for the interval it asked for.
        //
        // These throws are marked `final` so the catch below re-raises them
        // untouched. Without that it would re-judge a decision already made
        // here and retry an error we deliberately gave up on.
        if (!error.retryable || attempt === attempts) throw finalize(error);

        // A Retry-After longer than the caller is willing to wait is not
        // something to sleep through: a daily token budget can suggest hours,
        // and silently blocking a caller for hours is worse than telling them.
        // The hint is honoured up to `maxRetryDelayMs`, and beyond that the
        // error is surfaced with the hint intact so they can decide.
        const hintedMs =
          error.retryAfterSeconds === undefined ? undefined : error.retryAfterSeconds * 1000;
        if (hintedMs !== undefined && hintedMs > this.#maxRetryDelayMs) throw finalize(error);

        lastError = error;
        await this.#clock.sleep(hintedMs ?? backoffDelay(attempt, this.#retry));
      } catch (error) {
        // A decision already taken above is not revisited.
        if (isFinal(error)) throw error;

        // Everything reaching here is a transport failure: `fetch` rejecting,
        // the deadline firing, or the body failing to parse.
        //
        // A network failure on a non-idempotent request must not be retried —
        // the request may well have been received and acted on.
        if (!retryable || attempt === attempts) throw MaError.from(error);
        lastError = error;
        await this.#clock.sleep(backoffDelay(attempt, this.#retry));
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
        deadline.removeEventListener('abort', onAbort);
        timeout.abort();
      }
    }

    throw MaError.from(lastError);
  }

  /** Turn an error response into an `MaError` carrying the server's verdict. */
  async #toError(response: Response): Promise<MaError> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    const payload = (body as { error?: Record<string, unknown> } | undefined)?.error;
    const retryAfter = response.headers.get('retry-after');

    return new MaError({
      code: typeof payload?.code === 'string' ? payload.code : `HTTP_${response.status}`,
      category: categoryFor(response.status),
      message:
        typeof payload?.message === 'string' ? payload.message : `Request failed (${response.status})`,
      details: (payload?.details as Record<string, unknown>) ?? {},
      ...(typeof payload?.retryable === 'boolean' ? { retryable: payload.retryable } : {}),
      ...(retryAfter ? { retryAfterSeconds: Number(retryAfter) } : {}),
    });
  }

  /** A fresh idempotency key, for callers that do not supply one. */
  static idempotencyKey(): string {
    return randomToken(16);
  }

  // --- health & models -----------------------------------------------------

  health(): Promise<{ status: string; version: string }> {
    return this.#request('/health');
  }

  listModels(workspaceId?: string): Promise<{ models: Model[] }> {
    return this.#request('/v1/models', { query: { workspaceId } });
  }

  // --- workspaces ----------------------------------------------------------

  createWorkspace(input: {
    name: string;
    slug: string;
    description?: string;
    systemPrompt?: string;
    idempotencyKey?: string;
  }): Promise<{ workspace: Workspace }> {
    const { idempotencyKey, ...body } = input;
    return this.#request('/v1/workspaces', {
      method: 'POST',
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  listWorkspaces(page: PageRequest & { includeArchived?: boolean } = {}): Promise<Page<Workspace>> {
    return this.#request('/v1/workspaces', { query: page });
  }

  getWorkspace(workspaceId: string): Promise<{ workspace: Workspace }> {
    return this.#request(`/v1/workspaces/${workspaceId}`);
  }

  updateWorkspace(
    workspaceId: string,
    patch: { name?: string; description?: string; systemPrompt?: string },
  ): Promise<{ workspace: Workspace }> {
    return this.#request(`/v1/workspaces/${workspaceId}`, { method: 'PATCH', body: patch });
  }

  setMembers(
    workspaceId: string,
    members: { principalId: string; role: WorkspaceRole }[],
  ): Promise<{ workspace: Workspace }> {
    return this.#request(`/v1/workspaces/${workspaceId}/members`, {
      method: 'PUT',
      body: { members },
    });
  }

  getQuota(workspaceId: string): Promise<{
    limits: Record<string, number>;
    usage: { dimension: string; limit: number; observed: number }[];
  }> {
    return this.#request(`/v1/workspaces/${workspaceId}/quota`);
  }

  // --- agents --------------------------------------------------------------

  createAgent(
    workspaceId: string,
    input: {
      name: string;
      description?: string;
      labels?: string[];
      spec?: Record<string, unknown>;
      idempotencyKey?: string;
    },
  ): Promise<{ agent: Agent }> {
    const { idempotencyKey, ...body } = input;
    return this.#request(`/v1/workspaces/${workspaceId}/agents`, {
      method: 'POST',
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  listAgents(
    workspaceId: string,
    page: PageRequest & { includeArchived?: boolean } = {},
  ): Promise<Page<Agent>> {
    return this.#request(`/v1/workspaces/${workspaceId}/agents`, { query: page });
  }

  getAgent(agentId: string): Promise<{ agent: Agent }> {
    return this.#request(`/v1/agents/${agentId}`);
  }

  updateAgent(
    agentId: string,
    patch: { name?: string; description?: string; labels?: string[]; productionVersion?: number },
  ): Promise<{ agent: Agent }> {
    return this.#request(`/v1/agents/${agentId}`, { method: 'PATCH', body: patch });
  }

  archiveAgent(agentId: string, reason: string): Promise<{ agent: Agent }> {
    return this.#request(`/v1/agents/${agentId}/archive`, { method: 'POST', body: { reason } });
  }

  /**
   * Publish a new version.
   *
   * `spec` is merged over the base unless `replace` is set, and the response
   * carries the resulting diff — worth checking before anything relies on it.
   */
  createVersion(
    agentId: string,
    input: {
      spec: Record<string, unknown>;
      baseVersion?: number;
      changeSummary?: string;
      replace?: boolean;
      idempotencyKey?: string;
    },
  ): Promise<{
    version: AgentVersion;
    diff: { added: string[]; removed: string[]; changed: string[] };
  }> {
    const { idempotencyKey, ...body } = input;
    return this.#request(`/v1/agents/${agentId}/versions`, {
      method: 'POST',
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  listVersions(agentId: string, page: PageRequest = {}): Promise<Page<AgentVersion>> {
    return this.#request(`/v1/agents/${agentId}/versions`, { query: page });
  }

  getVersion(agentId: string, version: number): Promise<{ version: AgentVersion }> {
    return this.#request(`/v1/agents/${agentId}/versions/${version}`);
  }

  // --- sessions ------------------------------------------------------------

  createSession(input: {
    agentId: string;
    title?: string;
    agentVersion?: number;
    credentialIds?: string[];
    ttlSeconds?: number;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<{ session: Session }> {
    const { idempotencyKey, ...body } = input;
    return this.#request('/v1/sessions', {
      method: 'POST',
      body,
      // Default a key: creating a session twice because a response was lost is
      // exactly the failure idempotency exists to prevent.
      idempotencyKey: idempotencyKey ?? ManagedAgentClient.idempotencyKey(),
    });
  }

  listSessions(
    filter: PageRequest & { workspaceId?: string; agentId?: string; statuses?: SessionStatus[] } = {},
  ): Promise<Page<Session>> {
    const { statuses, ...rest } = filter;
    return this.#request('/v1/sessions', {
      query: { ...rest, ...(statuses ? { statuses: statuses.join(',') } : {}) },
    });
  }

  getSession(sessionId: string): Promise<{ session: Session }> {
    return this.#request(`/v1/sessions/${sessionId}`);
  }

  send(
    sessionId: string,
    events: UniversalEvent[],
    idempotencyKey?: string,
  ): Promise<{ accepted: number; session: Session }> {
    return this.#request(`/v1/sessions/${sessionId}/events`, {
      method: 'POST',
      body: { events },
      idempotencyKey: idempotencyKey ?? ManagedAgentClient.idempotencyKey(),
    });
  }

  /** Convenience for the common case. */
  prompt(sessionId: string, text: string): Promise<{ accepted: number; session: Session }> {
    return this.send(sessionId, [{ type: 'user.message', text, attachments: [] }]);
  }

  readEvents(
    sessionId: string,
    options: { fromSeq?: number; limit?: number; types?: string[] } = {},
  ): Promise<{ events: SessionEvent[]; earliestSeq: number; lastSeq: number }> {
    return this.#request(`/v1/sessions/${sessionId}/events`, {
      query: {
        fromSeq: options.fromSeq,
        limit: options.limit,
        ...(options.types ? { types: options.types.join(',') } : {}),
      },
    });
  }

  interrupt(sessionId: string, reason = ''): Promise<{ session: Session }> {
    return this.#request(`/v1/sessions/${sessionId}/interrupt`, {
      method: 'POST',
      body: { reason },
    });
  }

  terminate(sessionId: string, reason = ''): Promise<{ session: Session }> {
    return this.#request(`/v1/sessions/${sessionId}/terminate`, {
      method: 'POST',
      body: { reason },
    });
  }

  /**
   * Follow a session's events, reconnecting automatically.
   *
   * The iterator tracks the highest sequence it has yielded and resumes from
   * there, so a dropped connection produces neither a gap nor a repeat. It ends
   * when the session reaches a terminal state, or when `signal` aborts.
   */
  async *streamEvents(
    sessionId: string,
    options: { fromSeq?: number; types?: string[]; signal?: AbortSignal } = {},
  ): AsyncIterable<SessionEvent> {
    let cursor = options.fromSeq ?? 0;
    let attempt = 0;

    while (!options.signal?.aborted) {
      const url = new URL(`${this.#baseUrl}/v1/sessions/${sessionId}/events/stream`);
      url.searchParams.set('fromSeq', String(cursor));
      if (options.types) url.searchParams.set('types', options.types.join(','));

      let response: Response;
      try {
        response = await this.#fetch(url.toString(), {
          headers: {
            authorization: `Bearer ${this.#token}`,
            accept: 'text/event-stream',
            // Belt and braces alongside fromSeq: whichever the server prefers,
            // both name the same resume point.
            ...(cursor > 0 ? { 'last-event-id': String(cursor - 1) } : {}),
          },
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (options.signal?.aborted) return;
        // A transport failure is exactly what resume exists for.
        attempt++;
        if (attempt > 10) throw MaError.from(error);
        await this.#clock.sleep(backoffDelay(attempt, this.#retry));
        continue;
      }

      if (!response.ok) throw await this.#toError(response);
      if (!response.body) return;
      attempt = 0;

      try {
        for await (const event of parseSse(response.body, options.signal)) {
          // `cursor` is the next sequence we still need. Comparing against the
          // event's own sequence (rather than the cursor) is what keeps this
          // correct: after yielding seq N the cursor must become N+1, and an
          // out-of-order or repeated frame must not move it backwards.
          if (event.seq + 1 > cursor) cursor = event.seq + 1;
          yield event;

          if (
            event.type === 'session.terminated' ||
            event.type === 'session.failed' ||
            event.type === 'session.expired'
          ) {
            return;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) return;
        attempt++;
        if (attempt > 10) throw MaError.from(error);
      }

      // The stream ended without a terminal event: reconnect from the cursor.
      if (options.signal?.aborted) return;
      await this.#clock.sleep(backoffDelay(Math.max(attempt, 1), this.#retry));
    }
  }

  // --- credentials ---------------------------------------------------------

  /** Create a credential. Its value is write-only and never returned. */
  createCredential(
    workspaceId: string,
    input: {
      ownerType: 'workspace' | 'agent' | 'session' | 'principal';
      ownerId?: string;
      type: Credential['type'];
      name: string;
      description?: string;
      value: string;
      expiresAt?: number;
      valueKeys?: string[];
    },
  ): Promise<{ credential: Credential }> {
    return this.#request(`/v1/workspaces/${workspaceId}/credentials`, {
      method: 'POST',
      body: input,
    });
  }

  listCredentials(workspaceId: string, page: PageRequest = {}): Promise<Page<Credential>> {
    return this.#request(`/v1/workspaces/${workspaceId}/credentials`, { query: page });
  }

  deleteCredential(credentialId: string, reason: string): Promise<void> {
    return this.#request(`/v1/credentials/${credentialId}`, {
      method: 'DELETE',
      body: { reason },
    });
  }

  /** Extend a session's TTL, so a long-running agent is not reaped mid-work. */
  renew(sessionId: string, ttlSeconds: number): Promise<{ session: Session }> {
    return this.#request(`/v1/sessions/${sessionId}/renew`, {
      method: 'POST',
      body: { ttlSeconds },
    });
  }

  // --- artifacts -----------------------------------------------------------

  /** Files agents produced in this workspace. */
  listArtifacts(
    workspaceId: string,
    filter: { sessionId?: string } & PageRequest = {},
  ): Promise<Page<Artifact>> {
    return this.#request(`/v1/workspaces/${workspaceId}/artifacts`, { query: filter });
  }

  getArtifact(artifactId: string): Promise<Artifact> {
    return this.#request<{ artifact: Artifact }>(`/v1/artifacts/${artifactId}`).then(
      (body) => body.artifact,
    );
  }

  /**
   * An artifact's bytes.
   *
   * Returns bytes rather than text: an artifact is whatever the agent wrote,
   * and decoding a PNG as UTF-8 would corrupt it silently. The caller knows
   * what it asked for.
   */
  async downloadArtifact(artifactId: string): Promise<Uint8Array> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/artifacts/${artifactId}/content`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (!response.ok) throw await this.#toError(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Delete an artifact's content. The record survives as `purged`. */
  deleteArtifact(artifactId: string, reason: string): Promise<{ artifact: Artifact }> {
    return this.#request(`/v1/artifacts/${artifactId}`, {
      method: 'DELETE',
      query: { reason },
    });
  }

  /**
   * Mint a signed, expiring URL that renders an artifact on the preview origin.
   *
   * The URL needs no bearer, so it can be opened in a browser or embedded in an
   * `<iframe>`. Fails when the deployment has no separate preview origin, because
   * there is no safe same-origin preview of agent-authored content.
   */
  previewArtifact(artifactId: string): Promise<{ url: string; expiresAt: number }> {
    return this.#request(`/v1/artifacts/${artifactId}/preview-token`, { method: 'POST' });
  }

  // --- memories ------------------------------------------------------------

  listMemories(
    workspaceId: string,
    filter: { agentId?: string; injectableOnly?: boolean } & PageRequest = {},
  ): Promise<Page<Memory>> {
    return this.#request(`/v1/workspaces/${workspaceId}/memories`, { query: filter });
  }

  createMemory(
    workspaceId: string,
    input: {
      content: string;
      scope?: 'workspace' | 'agent';
      agentId?: string;
      kind?: 'fact' | 'preference' | 'procedure';
      injectable?: boolean;
    },
  ): Promise<Memory> {
    return this.#request<{ memory: Memory }>(`/v1/workspaces/${workspaceId}/memories`, {
      method: 'POST',
      body: input,
    }).then((body) => body.memory);
  }

  /**
   * Allow a memory into the system prompt, or withdraw it.
   *
   * Its own method rather than a field on an update, mirroring the API: this is
   * the only operation that moves agent-authored text across the trust
   * boundary, and it should be impossible to perform while meaning to edit
   * something else.
   */
  promoteMemory(memoryId: string, injectable: boolean): Promise<Memory> {
    return this.#request<{ memory: Memory }>(`/v1/memories/${memoryId}/promote`, {
      method: 'POST',
      body: { injectable },
    }).then((body) => body.memory);
  }

  forgetMemory(memoryId: string, reason: string): Promise<void> {
    return this.#request(`/v1/memories/${memoryId}`, { method: 'DELETE', query: { reason } });
  }

  // --- agent templates -----------------------------------------------------

  /** The catalogue a workspace can instantiate: its own templates and built-ins. */
  listTemplates(
    workspaceId: string,
    filter: { category?: string } & PageRequest = {},
  ): Promise<Page<AgentTemplate>> {
    return this.#request(`/v1/workspaces/${workspaceId}/templates`, { query: filter });
  }

  getTemplate(templateId: string): Promise<{ template: AgentTemplate }> {
    return this.#request(`/v1/templates/${templateId}`);
  }

  createTemplate(
    workspaceId: string,
    input: {
      name: string;
      description?: string;
      category?: string;
      spec: Record<string, unknown>;
      variables?: TemplateVariable[];
    },
  ): Promise<AgentTemplate> {
    return this.#request<{ template: AgentTemplate }>(
      `/v1/workspaces/${workspaceId}/templates`,
      { method: 'POST', body: input },
    ).then((body) => body.template);
  }

  updateTemplate(
    templateId: string,
    patch: {
      name?: string;
      description?: string;
      category?: string;
      spec?: Record<string, unknown>;
      variables?: TemplateVariable[];
    },
  ): Promise<AgentTemplate> {
    return this.#request<{ template: AgentTemplate }>(`/v1/templates/${templateId}`, {
      method: 'PATCH',
      body: patch,
    }).then((body) => body.template);
  }

  deleteTemplate(templateId: string): Promise<void> {
    return this.#request(`/v1/templates/${templateId}`, { method: 'DELETE' });
  }

  /** Build an agent from a template, substituting the supplied variables. */
  instantiateTemplate(
    workspaceId: string,
    templateId: string,
    input: {
      agentName?: string;
      description?: string;
      labels?: string[];
      variables?: Record<string, unknown>;
    } = {},
  ): Promise<Agent> {
    return this.#request<{ agent: Agent }>(
      `/v1/workspaces/${workspaceId}/templates/${templateId}/instantiate`,
      { method: 'POST', body: input },
    ).then((body) => body.agent);
  }
}

// --- SSE parsing -----------------------------------------------------------

/**
 * Parse an SSE byte stream into events.
 *
 * Frames are separated by a blank line and may arrive split across chunk
 * boundaries, so the buffer is only consumed up to the last complete frame.
 */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<SessionEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        // Comment-only frames are heartbeats.
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(dataLine.slice(6));
        } catch {
          // A malformed frame is skipped rather than ending the stream: one bad
          // frame should not cost the caller the rest of the session.
          continue;
        }

        // Not every frame is a session event. `stream.lagged` is a notice about
        // the stream itself: it carries no `id:` line, because a notice is
        // metadata rather than a position, and therefore no sequence. Yielding
        // it as a `SessionEvent` handed the caller an object with no `seq` and
        // no `type` — and `undefined + 1` is NaN, one comparison away from
        // poisoning the resume cursor.
        // The shared predicate, so this parser and the console's agree by
        // construction rather than by both remembering. See `isStreamEvent`
        // for why a `data:` frame is not necessarily an event.
        if (!isStreamEvent(parsed)) continue;
        yield parsed as SessionEvent;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function categoryFor(status: number): MaError['category'] {
  switch (status) {
    case 400:
      return 'validation';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'permission';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 412:
      return 'precondition';
    case 429:
      return 'quota';
    case 504:
      return 'timeout';
    case 503:
      return 'unavailable';
    default:
      return status >= 500 ? 'internal' : 'validation';
  }
}
