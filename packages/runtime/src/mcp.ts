/**
 * Model Context Protocol (MCP) client — stdio transport.
 *
 * An MCP server is an external tool provider the agent can call. This launches a
 * declared stdio server as a subprocess, speaks the JSON-RPC handshake
 * (`initialize` → `tools/list` → `tools/call`), and proxies each advertised tool
 * as a `Tool` the harness can dispatch like any other.
 *
 * The subprocess IS the isolation boundary — the same one the shell tool relies
 * on (`spawn` with an argument array, never a shell string). A server that
 * crashes or never handshakes must not wedge the session: its tools return an
 * error result, and the supervisor keeps the rest of the agent running.
 *
 * Tools are namespaced `mcp__<server>__<tool>` so two servers advertising the
 * same tool name cannot collide in the registry, and so an MCP tool named `run`
 * or `exec` is never mistaken for a shell command by the permission engine.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type { Clock, Logger } from '@ma/core';

import type { Tool, ToolContext, ToolResult } from './tools.ts';

/** One tool as advertised by an MCP server. */
interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: readonly string[];
  url?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  toolAllowlist?: readonly string[];
  /** Working directory for a stdio command — a plugin's unpacked bundle dir. */
  cwd?: string;
}

export interface McpConnection {
  readonly serverName: string;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  close(): void;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;
/** Cap on a single JSON-RPC message, so a hostile server cannot OOM the host. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Cap on an HTTP MCP response body. */
const MAX_HTTP_BYTES = 16 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 30_000;

/**
 * A live stdio MCP server: a subprocess speaking newline-delimited JSON-RPC.
 */
export class McpStdioConnection implements McpConnection {
  readonly serverName: string;
  readonly #child: ChildProcess;
  #nextId = 0;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #buffer = '';
  #stderr = '';
  #closed = false;
  readonly #logger: Logger | undefined;
  readonly #clock: Clock;

  private constructor(serverName: string, child: ChildProcess, clock: Clock, logger?: Logger) {
    this.serverName = serverName;
    this.#child = child;
    this.#clock = clock;
    this.#logger = logger;

    child.stdout?.on('data', (chunk: Buffer) => this.#onData(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr += chunk.toString('utf8');
      if (this.#stderr.length > 8_000) this.#stderr = this.#stderr.slice(-8_000);
    });
    child.once('exit', (code, signal) => {
      this.#closed = true;
      const reason = new Error(`MCP server '${serverName}' exited (code ${code}, signal ${signal})`);
      for (const p of this.#pending.values()) p.reject(reason);
      this.#pending.clear();
    });
    child.once('error', (error) => {
      this.#closed = true;
      for (const p of this.#pending.values()) p.reject(error instanceof Error ? error : new Error(String(error)));
      this.#pending.clear();
    });
  }

  /** Spawn the server and complete the MCP initialize handshake. */
  static async launch(config: McpServerConfig, clock: Clock, logger?: Logger): Promise<McpStdioConnection> {
    if (!config.command) throw new Error(`MCP server '${config.name}' has no command`);
    // A deliberately minimal environment. Spreading process.env would hand an
    // untrusted server/plugin the agent-core secrets (MA_RUNTIME_TOKEN,
    // MA_CONTROL_PLANE_URL) — the runtime token alone lets it exchange every
    // credential the version holds. Only PATH/HOME plus the server's own
    // resolved credential-ref env are passed, matching the shell tool and skill
    // entrypoints, which withhold the token for exactly this reason.
    const child = spawn(config.command, [...(config.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: config.cwd ?? process.env.HOME ?? '/tmp',
        ...(config.env ?? {}),
      },
      ...(config.cwd ? { cwd: config.cwd } : {}),
    });
    // A stdin write to a server that has closed its pipe raises EPIPE on the
    // stream; unhandled, it would crash the whole agent-core process.
    child.stdin?.on('error', () => {});
    const connection = new McpStdioConnection(config.name, child, clock, logger);
    try {
      await connection.#request(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'managed-agent', version: '0.1.0' },
        },
        HANDSHAKE_TIMEOUT_MS,
      );
    } catch (error) {
      // A server that never handshakes (or times out) must not be left running
      // as an orphaned subprocess.
      connection.close();
      throw error;
    }
    // Notify the server the handshake is complete (per MCP: notifications/initialized).
    connection.#notify('notifications/initialized', {});
    return connection;
  }

  #onData(text: string): void {
    this.#buffer += text;
    // A server that streams bytes with no newline would grow this buffer without
    // bound. Cap it: a single JSON-RPC line over the limit is not something we
    // will ever parse, so drop the connection rather than let it exhaust memory.
    if (this.#buffer.length > MAX_MESSAGE_BYTES) {
      const reason = new Error(`MCP server '${this.serverName}' sent an oversized message`);
      for (const p of this.#pending.values()) p.reject(reason);
      this.#pending.clear();
      this.#buffer = '';
      this.close();
      return;
    }
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf('\n');
      if (line.length === 0) continue;
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        if (typeof message.id !== 'number') continue; // a notification from the server
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'MCP error'));
        else pending.resolve(message.result);
      } catch {
        // A non-JSON line (some servers log to stdout) is ignored, not fatal.
      }
    }
  }

  #send(payload: Record<string, unknown>): void {
    if (this.#closed) throw new Error(`MCP server '${this.serverName}' is not running`);
    this.#child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  #notify(method: string, params: Record<string, unknown>): void {
    try {
      this.#send({ jsonrpc: '2.0', method, params });
    } catch {
      // Best-effort; a dead server is handled on the next request.
    }
  }

  #request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = ++this.#nextId;
    return new Promise<unknown>((resolve, reject) => {
      // A `clock.sleep` deadline rather than a bare timer, so tests can drive it.
      const deadline = new AbortController();
      const settle = (): void => {
        deadline.abort();
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        this.#pending.delete(id);
        settle();
        reject(new Error('aborted'));
      };
      this.#pending.set(id, {
        resolve: (v) => {
          settle();
          resolve(v);
        },
        reject: (e) => {
          settle();
          reject(e);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      void this.#clock.sleep(timeoutMs, deadline.signal).then(
        () => {
          if (!this.#pending.has(id)) return;
          this.#pending.delete(id);
          signal?.removeEventListener('abort', onAbort);
          reject(new Error(`MCP '${method}' on '${this.serverName}' timed out after ${timeoutMs}ms`));
        },
        () => {
          // Deadline aborted because the request already settled.
        },
      );
      try {
        this.#send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.#request('tools/list', {}, HANDSHAKE_TIMEOUT_MS)) as {
      tools?: McpToolDescriptor[];
    };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    try {
      const result = (await this.#request(
        'tools/call',
        { name, arguments: args },
        CALL_TIMEOUT_MS,
        signal,
      )) as { content?: { type: string; text?: string }[]; isError?: boolean };
      const output = (result.content ?? [])
        .map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
        .join('\n');
      return { output, ...(result.isError ? { isError: true } : {}) };
    } catch (error) {
      return {
        output: `MCP tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#child.pid) this.#child.kill('SIGKILL');
  }

  /** Captured stderr, for diagnosing a server that misbehaved. */
  get stderr(): string {
    return this.#stderr;
  }
}

/**
 * A remote MCP server over HTTP.
 *
 * No child process: each JSON-RPC request is one POST to the server's endpoint.
 * The `Tool` proxy is identical to the stdio case — only the transport differs —
 * so `createMcpTools` works over either without change. The sandbox's egress
 * policy must permit the endpoint host (derived into the allowlist at version
 * creation).
 */
export class McpHttpConnection implements McpConnection {
  readonly serverName: string;
  readonly #url: string;
  readonly #headers: Record<string, string>;
  #nextId = 0;

  constructor(serverName: string, url: string, headers: Record<string, string> = {}) {
    this.serverName = serverName;
    this.#url = url;
    this.#headers = headers;
  }

  async #request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const id = ++this.#nextId;
    // Always bound the request with a timeout — an unresponsive endpoint must
    // not hang boot or a turn forever. Compose the caller's signal (turn abort)
    // with our own deadline.
    const deadline = AbortSignal.timeout(HTTP_TIMEOUT_MS);
    const composed = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const response = await fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...this.#headers },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: composed,
    });
    if (!response.ok) throw new Error(`MCP '${method}' on '${this.serverName}' answered ${response.status}`);
    // Read the body with a byte cap rather than response.json(), which buffers
    // an unbounded body into memory.
    const text = await this.#readBounded(response);
    const message = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
    if (message.error) throw new Error(message.error.message ?? 'MCP error');
    return message.result;
  }

  async #readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_HTTP_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`MCP server '${this.serverName}' returned an oversized response`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.#request('tools/list', {})) as { tools?: McpToolDescriptor[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    try {
      const result = (await this.#request('tools/call', { name, arguments: args }, signal)) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      const output = (result.content ?? [])
        .map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
        .join('\n');
      return { output, ...(result.isError ? { isError: true } : {}) };
    } catch (error) {
      return {
        output: `MCP tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }

  close(): void {
    // Stateless transport: nothing to tear down.
  }
}

/** Namespaced tool name, collision-proof and never shell-classified. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * Proxy an MCP connection's advertised tools as harness `Tool`s.
 *
 * `toolAllowlist` (empty = all) filters which of the server's tools are exposed.
 * Each proxy forwards `tools/call` and maps the result; a failure becomes an
 * error `ToolResult` the model can adapt to, never a thrown exception that would
 * abort the turn.
 */
export async function createMcpTools(
  connection: McpConnection,
  options: { toolAllowlist?: readonly string[]; namePrefix?: string } = {},
): Promise<Tool[]> {
  const advertised = await connection.listTools();
  const allow = new Set(options.toolAllowlist ?? []);
  const selected = allow.size === 0 ? advertised : advertised.filter((t) => allow.has(t.name));
  // Plugins reuse this proxy but namespace their tools `plugin__…` instead of
  // `mcp__…`, so a plugin tool and an MCP tool of the same name never collide.
  const prefix = options.namePrefix ?? 'mcp';

  return selected.map((descriptor) => ({
    name: `${prefix}__${connection.serverName}__${descriptor.name}`,
    description: descriptor.description ?? `${prefix} tool ${descriptor.name} from ${connection.serverName}`,
    parameters: descriptor.inputSchema ?? { type: 'object', properties: {} },
    // MCP tools may mutate; treat them as not read-only so `plan` mode holds them.
    readOnly: false,
    execute: (args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> =>
      connection.callTool(descriptor.name, args, context.signal),
  }));
}

/**
 * Resolve `${cred:cr_...}` references in a server's env to their values.
 *
 * MCP server env carries credential *references*, never literals (the schema
 * enforces it), so a secret is never stored in a version row. The reference is
 * exchanged for its value here, at launch, through the same audited exchange the
 * rest of the sandbox uses. A reference that cannot be resolved fails the launch
 * rather than starting a server with a broken credential.
 */
export async function resolveCredentialRefs(
  env: Record<string, string>,
  exchange: (credentialId: string) => Promise<string>,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^\$\{cred:(cr_[A-Za-z0-9]+)\}$/.exec(value);
    resolved[key] = match ? await exchange(match[1]!) : value;
  }
  return resolved;
}

/**
 * Owns every MCP connection for one session.
 *
 * A single server failing to launch or handshake does not fail the session: it
 * is logged and its tools are simply absent, so the agent runs with whatever
 * servers did come up. `stop()` tears every connection down and is wired into
 * the sandbox's shutdown.
 */
export class McpSupervisor {
  readonly #connections: McpConnection[] = [];
  readonly #logger: Logger | undefined;
  readonly #clock: Clock;

  constructor(clock: Clock, logger?: Logger) {
    this.#clock = clock;
    this.#logger = logger;
  }

  /**
   * Launch every enabled stdio server and return the proxied tools of the ones
   * that came up. `exchangeCredential` resolves each server's credential-ref env.
   */
  async start(
    servers: readonly McpServerConfig[],
    exchangeCredential: (credentialId: string) => Promise<string>,
  ): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const config of servers) {
      if (config.enabled === false) continue;
      try {
        let connection: McpConnection;
        if (config.transport === 'stdio') {
          const env = await resolveCredentialRefs(config.env ?? {}, exchangeCredential);
          connection = await McpStdioConnection.launch({ ...config, env }, this.#clock, this.#logger);
        } else {
          // http/sse: a remote endpoint, no subprocess. Credential-ref env values
          // become request headers (e.g. an auth token).
          if (!config.url) throw new Error(`MCP server '${config.name}' has no url`);
          const headers = await resolveCredentialRefs(config.env ?? {}, exchangeCredential);
          connection = new McpHttpConnection(config.name, config.url, headers);
        }
        this.#connections.push(connection);
        const serverTools = await createMcpTools(connection, {
          ...(config.toolAllowlist ? { toolAllowlist: config.toolAllowlist } : {}),
        });
        tools.push(...serverTools);
      } catch (error) {
        // One bad server does not sink the session; its tools are just absent.
        this.#logger?.error('failed to launch an MCP server', { server: config.name, error });
      }
    }
    return tools;
  }

  /**
   * Launch a plugin: an unpacked bundle whose manifest declares a command, run
   * as a local stdio MCP server from its bundle directory. Its tools are proxied
   * `plugin__<name>__<tool>`. Reuses the MCP substrate so a plugin gets the same
   * subprocess isolation and crash handling; a failure is logged, not fatal.
   */
  async launchPlugin(
    config: McpServerConfig,
    exchangeCredential: (credentialId: string) => Promise<string>,
  ): Promise<Tool[]> {
    try {
      const env = await resolveCredentialRefs(config.env ?? {}, exchangeCredential);
      const connection = await McpStdioConnection.launch({ ...config, env }, this.#clock, this.#logger);
      this.#connections.push(connection);
      return await createMcpTools(connection, {
        namePrefix: 'plugin',
        ...(config.toolAllowlist ? { toolAllowlist: config.toolAllowlist } : {}),
      });
    } catch (error) {
      this.#logger?.error('failed to launch a plugin', { plugin: config.name, error });
      return [];
    }
  }

  stop(): void {
    for (const connection of this.#connections) {
      try {
        connection.close();
      } catch {
        // Best-effort teardown.
      }
    }
    this.#connections.length = 0;
  }
}

