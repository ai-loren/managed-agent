/**
 * Wire-faithful stand-ins for the native model providers.
 *
 * One HTTP server answers as Anthropic, Azure OpenAI, AWS Bedrock and Google
 * Vertex AI (with its OAuth token endpoint). Each checks a request the way the
 * real service refuses one — the credential (Bedrock's SigV4 signature is
 * recomputed here, independently of the code under test; Vertex's tokens come
 * only from a JWT grant whose RS256 signature is verified), the path, and the
 * conversation rules that fail a request outright: roles that must alternate,
 * tool results that must answer the turn before, tool blocks that need tools
 * declared, blank text, schema keys Gemini does not know. A refused request
 * gets the provider's own error shape and status.
 *
 * What the model says comes from a `Brain` over a provider-neutral view of the
 * conversation, so one script drives a tool-using session on any provider.
 */

import { createHash, createHmac, createVerify, generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

export type FakeProvider = 'anthropic' | 'azure' | 'bedrock' | 'vertex';

/** One turn of a conversation, the same whichever provider carried it. */
export interface NeutralTurn {
  role: 'user' | 'assistant';
  text: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  toolResults: string[];
}

export interface BrainReply {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}

export type Brain = (turns: NeutralTurn[], context: { provider: FakeProvider; model: string; tools: string[] }) => BrainReply;

/**
 * The default script. A user turn saying `CALL <tool> <json>` asks for that
 * call; once a result has come back after it, the answer is `RESULT: <results>`.
 * Anything else is echoed.
 */
export const callThenAnswer: Brain = (turns) => {
  let directive = -1;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    if (turn.role === 'user' && /CALL \w+ \{/.test(turn.text)) {
      directive = index;
      break;
    }
  }
  if (directive < 0) {
    const last = [...turns].reverse().find((turn) => turn.role === 'user' && turn.text.length > 0);
    return { text: `echo: ${last?.text ?? ''}` };
  }
  const results = turns.slice(directive + 1).flatMap((turn) => turn.toolResults);
  if (results.length > 0) return { text: `RESULT: ${results.join(' | ')}` };
  const match = /CALL (\w+) (\{.*\})/s.exec(turns[directive]!.text)!;
  return { toolCalls: [{ name: match[1]!, args: JSON.parse(match[2]!) as Record<string, unknown> }] };
};

/** Usage every fake reports, in each provider's own fields; normalised it is the same four numbers. */
export const FAKE_USAGE = { input: 1000, output: 200, cacheRead: 300, cacheWrite: 50 };

export interface FakeCall {
  provider: FakeProvider;
  model: string;
  status: number;
  body: unknown;
  turns: NeutralTurn[];
  tools: string[];
}

interface Failure {
  provider: FakeProvider;
  status: number;
  remaining: number;
}

export const FAKE_AWS = { accessKeyId: 'AKIDFAKEBEDROCK0001', secretAccessKey: 'fake-bedrock-secret-key/abc+123', region: 'us-west-2' };
export const FAKE_ANTHROPIC_KEY = 'sk-ant-fake-key';
export const FAKE_AZURE_KEY = 'fake-azure-api-key';
export const FAKE_VERTEX = { project: 'fake-project', location: 'us-central1', email: 'agent@fake-project.iam.gserviceaccount.com' };
/** The user credentials `gcloud auth application-default login` writes. */
export const FAKE_ADC = { client_id: 'fake-client.apps.googleusercontent.com', client_secret: 'fake-client-secret', refresh_token: '1//fake-refresh-token' };

export class ProviderFakes {
  readonly calls: FakeCall[] = [];
  readonly failures: Failure[] = [];
  brain: Brain = callThenAnswer;
  origin = '';
  /** Models each provider serves; a call naming another is refused as the provider refuses it. */
  readonly models: Record<FakeProvider, Set<string>> = {
    anthropic: new Set(),
    azure: new Set(),
    bedrock: new Set(),
    vertex: new Set(),
  };
  readonly #issuedTokens = new Set<string>();
  readonly #keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  #server: Server | undefined;

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ message: String(error) }));
      });
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.#server.address() as { port: number }).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  /** The next `count` calls to `provider` fail with `status`, in that provider's error shape. */
  fail(provider: FakeProvider, status: number, count = 1): void {
    this.failures.push({ provider, status, remaining: count });
  }

  callsTo(provider: FakeProvider): FakeCall[] {
    return this.calls.filter((call) => call.provider === provider);
  }

  /** A service account key whose token endpoint is this fake; write it where the platform reads it. */
  writeServiceAccount(dir: string): string {
    const path = join(dir, 'vertex-service-account.json');
    writeFileSync(
      path,
      JSON.stringify({
        type: 'service_account',
        project_id: FAKE_VERTEX.project,
        private_key_id: 'fake-key-1',
        private_key: this.#keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        client_email: FAKE_VERTEX.email,
        token_uri: `${this.origin}/token`,
      }),
    );
    return path;
  }

  /** Env that points every native provider at this fake. */
  env(dir: string, models: { anthropic?: string; azure?: string; bedrock?: string; vertex?: string }): Record<string, string> {
    return {
      ...(models.anthropic
        ? { MA_ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, MA_ANTHROPIC_BASE_URL: this.origin, MA_ANTHROPIC_MODELS: models.anthropic }
        : {}),
      ...(models.azure
        ? {
            MA_AZURE_OPENAI_API_KEY: FAKE_AZURE_KEY,
            MA_AZURE_OPENAI_ENDPOINT: this.origin,
            MA_AZURE_OPENAI_API_VERSION: '2024-10-21',
            MA_AZURE_OPENAI_MODELS: models.azure,
          }
        : {}),
      ...(models.bedrock
        ? {
            MA_BEDROCK_MODELS: models.bedrock,
            MA_BEDROCK_REGION: FAKE_AWS.region,
            MA_BEDROCK_ENDPOINT: this.origin,
            AWS_ACCESS_KEY_ID: FAKE_AWS.accessKeyId,
            AWS_SECRET_ACCESS_KEY: FAKE_AWS.secretAccessKey,
          }
        : {}),
      ...(models.vertex
        ? {
            MA_VERTEX_MODELS: models.vertex,
            MA_VERTEX_PROJECT: FAKE_VERTEX.project,
            MA_VERTEX_LOCATION: FAKE_VERTEX.location,
            MA_VERTEX_ENDPOINT: this.origin,
            MA_VERTEX_CREDENTIALS_FILE: this.writeServiceAccount(dir),
          }
        : {}),
    };
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request);
    const url = new URL(request.url ?? '/', this.origin);
    if (request.method === 'POST' && url.pathname === '/v1/messages') return this.#anthropic(request, response, raw);
    if (request.method === 'POST' && /^\/openai\/deployments\/[^/]+\/chat\/completions$/.test(url.pathname)) {
      return this.#azure(request, response, url, raw);
    }
    if (request.method === 'POST' && /^\/model\/[^/]+\/converse$/.test(url.pathname)) return this.#bedrock(request, response, url, raw);
    if (request.method === 'POST' && url.pathname === '/token') return this.#token(response, raw);
    if (request.method === 'GET' && url.pathname === '/computeMetadata/v1/instance/service-accounts/default/token') {
      return this.#metadataToken(request, response);
    }
    if (request.method === 'POST' && url.pathname.endsWith(':generateContent')) return this.#vertex(request, response, url, raw);
    send(response, 404, { message: `no fake route for ${request.method} ${url.pathname}` });
  }

  #failure(provider: FakeProvider): number | undefined {
    const failure = this.failures.find((entry) => entry.provider === provider && entry.remaining > 0);
    if (!failure) return undefined;
    failure.remaining--;
    return failure.status;
  }

  #record(provider: FakeProvider, model: string, status: number, body: unknown, turns: NeutralTurn[], tools: string[]): void {
    this.calls.push({ provider, model, status, body, turns, tools });
  }

  // --- Anthropic ------------------------------------------------------------

  #anthropic(request: IncomingMessage, response: ServerResponse, raw: string): void {
    const refuse = (status: number, type: string, message: string): void =>
      send(response, status, { type: 'error', error: { type, message } });
    if (request.headers['x-api-key'] !== FAKE_ANTHROPIC_KEY) return refuse(401, 'authentication_error', 'invalid x-api-key');
    if (!request.headers['anthropic-version']) return refuse(400, 'invalid_request_error', 'anthropic-version: header is required');
    const body = JSON.parse(raw) as Record<string, any>;
    if (!this.models.anthropic.has(body.model)) return refuse(404, 'not_found_error', `model: ${String(body.model)}`);
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return refuse(400, 'invalid_request_error', 'max_tokens: Field required');
    const problem = anthropicProblem(body);
    if (problem) {
      this.#record('anthropic', body.model, 400, body, [], []);
      return refuse(400, 'invalid_request_error', problem);
    }
    const tools = (body.tools ?? []).map((tool: { name: string }) => tool.name);
    const turns: NeutralTurn[] = body.messages.map((message: { role: 'user' | 'assistant'; content: unknown }) => {
      const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content as any[]);
      return {
        role: message.role,
        text: blocks.filter((block) => block.type === 'text').map((block) => block.text).join(''),
        toolCalls: blocks.filter((block) => block.type === 'tool_use').map((block) => ({ name: block.name, args: block.input })),
        toolResults: blocks.filter((block) => block.type === 'tool_result').map((block) => contentText(block.content)),
      };
    });
    const failed = this.#failure('anthropic');
    if (failed) {
      this.#record('anthropic', body.model, failed, body, turns, tools);
      return failed === 529 ? refuse(529, 'overloaded_error', 'Overloaded') : refuse(failed, failed === 429 ? 'rate_limit_error' : 'api_error', `fake failure ${failed}`);
    }
    this.#record('anthropic', body.model, 200, body, turns, tools);
    const reply = this.brain(turns, { provider: 'anthropic', model: body.model, tools });
    send(response, 200, {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [
        ...(reply.text ? [{ type: 'text', text: reply.text }] : []),
        ...(reply.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: `toolu_${randomUUID().slice(0, 12)}`, name: call.name, input: call.args })),
      ],
      stop_reason: reply.toolCalls?.length ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: FAKE_USAGE.input,
        output_tokens: FAKE_USAGE.output,
        cache_read_input_tokens: FAKE_USAGE.cacheRead,
        cache_creation_input_tokens: FAKE_USAGE.cacheWrite,
      },
    });
  }

  // --- Azure OpenAI ---------------------------------------------------------

  #azure(request: IncomingMessage, response: ServerResponse, url: URL, raw: string): void {
    const refuse = (status: number, code: string, message: string): void => send(response, status, { error: { code, message } });
    if (request.headers['api-key'] !== FAKE_AZURE_KEY) {
      return refuse(401, '401', 'Access denied due to invalid subscription key or wrong API endpoint.');
    }
    if (!url.searchParams.get('api-version')) return refuse(404, '404', 'Resource not found');
    const deployment = decodeURIComponent(url.pathname.split('/')[3]!);
    if (!this.models.azure.has(deployment)) return refuse(404, 'DeploymentNotFound', `The API deployment for this resource does not exist.`);
    const body = JSON.parse(raw) as Record<string, any>;
    const problem = openAiProblem(body);
    if (problem) {
      this.#record('azure', deployment, 400, body, [], []);
      return refuse(400, 'BadRequest', problem);
    }
    const tools = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
    const turns: NeutralTurn[] = [];
    for (const message of body.messages as any[]) {
      if (message.role === 'system') continue;
      if (message.role === 'tool') {
        const last = turns[turns.length - 1];
        if (last?.role === 'user') last.toolResults.push(String(message.content));
        else turns.push({ role: 'user', text: '', toolCalls: [], toolResults: [String(message.content)] });
        continue;
      }
      turns.push({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        text: String(message.content ?? ''),
        toolCalls: (message.tool_calls ?? []).map((call: any) => ({ name: call.function.name, args: JSON.parse(call.function.arguments) })),
        toolResults: [],
      });
    }
    const failed = this.#failure('azure');
    if (failed) {
      this.#record('azure', deployment, failed, body, turns, tools);
      return send(response, failed, { error: { code: String(failed), message: `fake failure ${failed}` } }, failed === 429 ? { 'retry-after': '0' } : {});
    }
    this.#record('azure', deployment, 200, body, turns, tools);
    const reply = this.brain(turns, { provider: 'azure', model: deployment, tools });
    send(response, 200, {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      model: 'gpt-4o-2024-08-06',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: reply.text ?? null,
            ...(reply.toolCalls?.length
              ? {
                  tool_calls: reply.toolCalls.map((call) => ({
                    id: `call_${randomUUID().slice(0, 12)}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  })),
                }
              : {}),
          },
          finish_reason: reply.toolCalls?.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: FAKE_USAGE.input + FAKE_USAGE.cacheRead,
        completion_tokens: FAKE_USAGE.output,
        total_tokens: FAKE_USAGE.input + FAKE_USAGE.cacheRead + FAKE_USAGE.output,
        prompt_tokens_details: { cached_tokens: FAKE_USAGE.cacheRead },
      },
    });
  }

  // --- Bedrock --------------------------------------------------------------

  #bedrock(request: IncomingMessage, response: ServerResponse, url: URL, raw: string): void {
    const refuse = (status: number, type: string, message: string): void =>
      send(response, status, { message }, { 'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/` });
    const signature = verifySigV4(request, url, raw);
    if (signature) return refuse(403, signature.type, signature.message);
    const modelId = decodeURIComponent(url.pathname.split('/')[2]!);
    if (!this.models.bedrock.has(modelId)) return refuse(404, 'ResourceNotFoundException', 'Model not found.');
    const body = JSON.parse(raw) as Record<string, any>;
    const problem = converseProblem(body);
    if (problem) {
      this.#record('bedrock', modelId, 400, body, [], []);
      return refuse(400, 'ValidationException', problem);
    }
    const tools = (body.toolConfig?.tools ?? []).map((tool: any) => tool.toolSpec.name);
    const turns: NeutralTurn[] = body.messages.map((message: any) => ({
      role: message.role,
      text: message.content.filter((block: any) => typeof block.text === 'string').map((block: any) => block.text).join(''),
      toolCalls: message.content.filter((block: any) => block.toolUse).map((block: any) => ({ name: block.toolUse.name, args: block.toolUse.input })),
      toolResults: message.content.filter((block: any) => block.toolResult).map((block: any) => contentText(block.toolResult.content)),
    }));
    const failed = this.#failure('bedrock');
    if (failed) {
      this.#record('bedrock', modelId, failed, body, turns, tools);
      return refuse(failed, failed === 429 ? 'ThrottlingException' : 'ServiceUnavailableException', `fake failure ${failed}`);
    }
    this.#record('bedrock', modelId, 200, body, turns, tools);
    const reply = this.brain(turns, { provider: 'bedrock', model: modelId, tools });
    send(response, 200, {
      output: {
        message: {
          role: 'assistant',
          content: [
            ...(reply.text ? [{ text: reply.text }] : []),
            ...(reply.toolCalls ?? []).map((call) => ({ toolUse: { toolUseId: `tooluse_${randomUUID().slice(0, 12)}`, name: call.name, input: call.args } })),
          ],
        },
      },
      stopReason: reply.toolCalls?.length ? 'tool_use' : 'end_turn',
      usage: {
        inputTokens: FAKE_USAGE.input,
        outputTokens: FAKE_USAGE.output,
        totalTokens: FAKE_USAGE.input + FAKE_USAGE.output + FAKE_USAGE.cacheRead + FAKE_USAGE.cacheWrite,
        cacheReadInputTokens: FAKE_USAGE.cacheRead,
        cacheWriteInputTokens: FAKE_USAGE.cacheWrite,
      },
      metrics: { latencyMs: 5 },
    });
  }

  // --- Vertex AI ------------------------------------------------------------

  /** A fresh access token, which generateContent then accepts. */
  #issue(response: ServerResponse): void {
    const token = `ya29.fake-${randomUUID()}`;
    this.#issuedTokens.add(token);
    send(response, 200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
  }

  /** The GCE metadata server: a token for the instance's service account, only with its header. */
  #metadataToken(request: IncomingMessage, response: ServerResponse): void {
    if (request.headers['metadata-flavor'] !== 'Google') return send(response, 403, { error: 'Missing Metadata-Flavor: Google header' });
    this.#issue(response);
  }

  #token(response: ServerResponse, raw: string): void {
    const form = new URLSearchParams(raw);
    const refuse = (description: string): void => send(response, 400, { error: 'invalid_grant', error_description: description });
    if (form.get('grant_type') === 'refresh_token') {
      const valid =
        form.get('client_id') === FAKE_ADC.client_id &&
        form.get('client_secret') === FAKE_ADC.client_secret &&
        form.get('refresh_token') === FAKE_ADC.refresh_token;
      return valid ? this.#issue(response) : refuse('Token has been expired or revoked.');
    }
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return refuse('Invalid grant_type');
    const [header = '', claims = '', signature = ''] = (form.get('assertion') ?? '').split('.');
    const verified = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(this.#keys.publicKey, Buffer.from(signature, 'base64url'));
    if (!verified) return refuse('Invalid JWT Signature.');
    const head = JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<string, unknown>;
    const body = JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, any>;
    const now = Math.floor(Date.now() / 1000);
    if (head.alg !== 'RS256') return refuse('Invalid JWT: alg must be RS256');
    if (body.iss !== FAKE_VERTEX.email) return refuse('Invalid JWT: iss');
    if (body.aud !== `${this.origin}/token`) return refuse('Invalid JWT: aud');
    if (!String(body.scope ?? '').split(' ').includes('https://www.googleapis.com/auth/cloud-platform')) return refuse('Invalid JWT: scope');
    if (!(body.exp > now && body.exp - body.iat <= 3600 && body.iat <= now + 300)) return refuse('Invalid JWT: Token must be a short-lived token');
    this.#issue(response);
  }

  #vertex(request: IncomingMessage, response: ServerResponse, url: URL, raw: string): void {
    const refuse = (status: number, state: string, message: string): void =>
      send(response, status, { error: { code: status, message, status: state } });
    const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!this.#issuedTokens.has(token)) return refuse(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
    const match = /^\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^/:]+):generateContent$/.exec(url.pathname);
    if (!match || match[1] !== FAKE_VERTEX.project || match[2] !== FAKE_VERTEX.location) {
      return refuse(404, 'NOT_FOUND', `Requested entity was not found: ${url.pathname}`);
    }
    const model = decodeURIComponent(match[3]!);
    if (!this.models.vertex.has(model)) return refuse(404, 'NOT_FOUND', `Publisher Model \`${model}\` not found.`);
    const body = JSON.parse(raw) as Record<string, any>;
    const problem = geminiProblem(body);
    if (problem) {
      this.#record('vertex', model, 400, body, [], []);
      return refuse(400, 'INVALID_ARGUMENT', problem);
    }
    const tools = (body.tools ?? []).flatMap((tool: any) => (tool.functionDeclarations ?? []).map((declaration: any) => declaration.name));
    const turns: NeutralTurn[] = body.contents.map((content: any) => ({
      role: content.role === 'model' ? 'assistant' : 'user',
      text: content.parts.filter((part: any) => typeof part.text === 'string').map((part: any) => part.text).join(''),
      toolCalls: content.parts.filter((part: any) => part.functionCall).map((part: any) => ({ name: part.functionCall.name, args: part.functionCall.args ?? {} })),
      toolResults: content.parts.filter((part: any) => part.functionResponse).map((part: any) => String(part.functionResponse.response?.content ?? JSON.stringify(part.functionResponse.response))),
    }));
    const failed = this.#failure('vertex');
    if (failed) {
      this.#record('vertex', model, failed, body, turns, tools);
      return refuse(failed, failed === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE', `fake failure ${failed}`);
    }
    this.#record('vertex', model, 200, body, turns, tools);
    const reply = this.brain(turns, { provider: 'vertex', model, tools });
    send(response, 200, {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [...(reply.text ? [{ text: reply.text }] : []), ...(reply.toolCalls ?? []).map((call) => ({ functionCall: { name: call.name, args: call.args } }))],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: FAKE_USAGE.input + FAKE_USAGE.cacheRead,
        candidatesTokenCount: FAKE_USAGE.output,
        cachedContentTokenCount: FAKE_USAGE.cacheRead,
        totalTokenCount: FAKE_USAGE.input + FAKE_USAGE.cacheRead + FAKE_USAGE.output,
      },
      modelVersion: model,
    });
  }
}

// --- the rules each provider enforces -----------------------------------------

/** Anthropic's refusal for this body, or undefined when it would be accepted. */
export function anthropicProblem(body: Record<string, any>): string | undefined {
  if (body.system !== undefined && typeof body.system !== 'string' && !Array.isArray(body.system)) return 'system: Input should be a valid string';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages: at least one message is required';
  let usesTools = false;
  for (const [index, message] of body.messages.entries()) {
    if (message.role !== 'user' && message.role !== 'assistant') return `messages.${index}.role: Input should be 'user' or 'assistant'`;
    if (index === 0 && message.role !== 'user') return 'messages: first message must use the "user" role';
    if (index > 0 && body.messages[index - 1].role === message.role) return 'messages: roles must alternate between "user" and "assistant"';
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(blocks) || blocks.length === 0) return `messages.${index}: content must be non-empty`;
    let seenOther = false;
    for (const block of blocks) {
      if (block.type === 'text') {
        if (typeof block.text !== 'string' || block.text.trim().length === 0) return `messages.${index}: text content blocks must be non-empty`;
        seenOther = true;
      } else if (block.type === 'tool_use') {
        usesTools = true;
        if (message.role !== 'assistant') return `messages.${index}: tool_use blocks are only allowed in assistant messages`;
        if (typeof block.id !== 'string' || typeof block.name !== 'string' || typeof block.input !== 'object') return `messages.${index}: tool_use needs id, name and input`;
        seenOther = true;
      } else if (block.type === 'tool_result') {
        usesTools = true;
        if (seenOther) return `messages.${index}: tool_result blocks must come first in the user message`;
        const previous = body.messages[index - 1];
        const ids = (Array.isArray(previous?.content) ? previous.content : []).filter((b: any) => b.type === 'tool_use').map((b: any) => b.id);
        if (!ids.includes(block.tool_use_id)) return `messages.${index}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${block.tool_use_id}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`;
      } else {
        return `messages.${index}: unknown content block type ${String(block.type)}`;
      }
    }
    if (message.role === 'assistant') {
      const uses = blocks.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id);
      const next = body.messages[index + 1];
      if (uses.length > 0 && next) {
        const answered = (Array.isArray(next.content) ? next.content : []).filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id);
        const missing = uses.filter((id: string) => !answered.includes(id));
        if (missing.length > 0) return `messages.${index + 1}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(', ')}`;
      }
    }
  }
  if (usesTools && !(Array.isArray(body.tools) && body.tools.length > 0)) return 'Requests which include `tool_use` or `tool_result` blocks must define tools.';
  for (const tool of body.tools ?? []) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name ?? '')) return `tools: name must match ^[a-zA-Z0-9_-]{1,64}$`;
    if (tool.input_schema?.type !== 'object') return `tools.${tool.name}.input_schema.type: Input should be 'object'`;
  }
  return undefined;
}

/** OpenAI chat completions' refusal for this body (Azure enforces the same rules). */
export function openAiProblem(body: Record<string, any>): string | undefined {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return "'messages' must contain at least one message";
  for (const [index, message] of body.messages.entries()) {
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) return `messages[${index}].role is invalid`;
    if (message.role === 'tool') {
      let previous = index - 1;
      while (previous >= 0 && body.messages[previous].role === 'tool') previous--;
      const ids = (body.messages[previous]?.tool_calls ?? []).map((call: any) => call.id);
      if (!ids.includes(message.tool_call_id)) {
        return "Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.";
      }
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const answered = new Set<string>();
      for (let next = index + 1; next < body.messages.length && body.messages[next].role === 'tool'; next++) answered.add(body.messages[next].tool_call_id);
      const missing = message.tool_calls.filter((call: any) => !answered.has(call.id));
      if (missing.length > 0 && index + 1 < body.messages.length) {
        return "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.";
      }
      for (const call of message.tool_calls) {
        if (call.type !== 'function' || typeof call.function?.arguments !== 'string') return `messages[${index}].tool_calls: function arguments must be a string`;
      }
    }
  }
  for (const tool of body.tools ?? []) {
    if (tool.type !== 'function' || typeof tool.function?.name !== 'string') return "tools: each tool must be {type: 'function', function: {name, parameters}}";
  }
  return undefined;
}

/** Bedrock Converse's refusal for this body. */
export function converseProblem(body: Record<string, any>): string | undefined {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'The model returned the following errors: messages: at least one message is required';
  let usesTools = false;
  for (const [index, message] of body.messages.entries()) {
    if (index === 0 && message.role !== 'user') return 'A conversation must start with a user message. Try again with a conversation that starts with a user message.';
    if (index > 0 && body.messages[index - 1].role === message.role) return 'A conversation must alternate between user and assistant roles. Make sure the conversation alternates between user and assistant roles and try again.';
    if (!Array.isArray(message.content) || message.content.length === 0) return `The content field in the Message object at messages.${index} is empty. Add a ContentBlock object to the content field and try again.`;
    const results: string[] = [];
    for (const block of message.content) {
      if ('text' in block) {
        if (typeof block.text !== 'string' || block.text.trim().length === 0) return `The text field in the ContentBlock object at messages.${index} is blank. Add text to the text field, and try again.`;
      } else if (block.toolUse) {
        usesTools = true;
        if (message.role !== 'assistant') return `messages.${index}: toolUse is only allowed in assistant messages`;
      } else if (block.toolResult) {
        usesTools = true;
        results.push(block.toolResult.toolUseId);
        if (!Array.isArray(block.toolResult.content) || block.toolResult.content.length === 0) return `messages.${index}: toolResult content is empty`;
      } else {
        return `messages.${index}: unknown content block`;
      }
    }
    if (results.length > 0) {
      const uses = (body.messages[index - 1]?.content ?? []).filter((block: any) => block.toolUse).map((block: any) => block.toolUse.toolUseId);
      if (results.length !== uses.length || results.some((id) => !uses.includes(id))) {
        return `The number of toolResult blocks at messages.${index}.content exceeds the number of toolUse blocks of previous turn.`;
      }
    }
  }
  if (usesTools && !(Array.isArray(body.toolConfig?.tools) && body.toolConfig.tools.length > 0)) {
    return 'The toolConfig field must be defined when using toolUse and toolResult content blocks.';
  }
  for (const tool of body.toolConfig?.tools ?? []) {
    if (typeof tool.toolSpec?.name !== 'string' || typeof tool.toolSpec?.inputSchema?.json !== 'object') return 'toolConfig.tools: each needs toolSpec {name, inputSchema: {json}}';
  }
  if (body.system !== undefined && (!Array.isArray(body.system) || body.system.some((block: any) => typeof block.text !== 'string' || block.text.length === 0))) {
    return 'system: each SystemContentBlock needs non-empty text';
  }
  return undefined;
}

const GEMINI_SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'title', 'propertyOrdering']);
const GEMINI_TYPES = new Set(['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY', 'OBJECT']);

function schemaProblem(schema: any, path: string): string | undefined {
  for (const key of Object.keys(schema ?? {})) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) return `Invalid JSON payload received. Unknown name "${key}" at '${path}': Cannot find field.`;
  }
  if (schema.type !== undefined && !GEMINI_TYPES.has(String(schema.type).toUpperCase())) return `Invalid value at '${path}.type' (type.googleapis.com/google.cloud.aiplatform.v1.Type), "${String(schema.type)}"`;
  if (String(schema.type).toUpperCase() === 'OBJECT' && schema.properties !== undefined && Object.keys(schema.properties).length === 0) {
    return `${path}.properties: should be non-empty for OBJECT type`;
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const problem = schemaProblem(child, `${path}.properties[${name}]`);
    if (problem) return problem;
  }
  if (schema.items) return schemaProblem(schema.items, `${path}.items`);
  return undefined;
}

/** Vertex AI's refusal for this generateContent body. */
export function geminiProblem(body: Record<string, any>): string | undefined {
  if (!Array.isArray(body.contents) || body.contents.length === 0) return 'Unable to submit request because it must include at least one content.';
  for (const [index, content] of body.contents.entries()) {
    if (content.role !== 'user' && content.role !== 'model') return `Please use a valid role: user, model. (contents[${index}].role = ${String(content.role)})`;
    if (!Array.isArray(content.parts) || content.parts.length === 0) return `Unable to submit request because it must include at least one parts field (contents[${index}]).`;
    for (const part of content.parts) {
      const kinds = ['text', 'functionCall', 'functionResponse'].filter((kind) => part[kind] !== undefined);
      if (kinds.length !== 1) return `contents[${index}].parts: each part must have exactly one of text, functionCall, functionResponse`;
      if (part.text !== undefined && String(part.text).length === 0) return 'Unable to submit request because it has an empty text parameter. Add a value to the parameter and try again.';
    }
    const responses = content.parts.filter((part: any) => part.functionResponse);
    if (responses.length > 0) {
      const calls = (body.contents[index - 1]?.role === 'model' ? body.contents[index - 1].parts : []).filter((part: any) => part.functionCall);
      if (calls.length !== responses.length) {
        return 'Please ensure that the number of function response parts is equal to the number of function call parts of the function call turn.';
      }
      const names = calls.map((part: any) => part.functionCall.name);
      if (responses.some((part: any) => !names.includes(part.functionResponse.name))) return 'Please ensure that function response turn comes immediately after a function call turn, with matching names.';
    }
  }
  for (const tool of body.tools ?? []) {
    for (const [index, declaration] of (tool.functionDeclarations ?? []).entries()) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(declaration.name ?? '')) return `tools[0].function_declarations[${index}].name: Invalid function name`;
      if (declaration.parameters) {
        const problem = schemaProblem(declaration.parameters, `tools[0].function_declarations[${index}].parameters`);
        if (problem) return problem;
      }
    }
  }
  return undefined;
}

// --- SigV4, recomputed from the AWS specification ------------------------------

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Why AWS would refuse this request's signature, or undefined when it verifies. */
export function verifySigV4(request: IncomingMessage, url: URL, body: string): { type: string; message: string } | undefined {
  const authorization = String(request.headers.authorization ?? '');
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(authorization);
  if (!match) return { type: 'IncompleteSignatureException', message: 'Authorization header requires Credential, SignedHeaders and Signature.' };
  const [, accessKey, date, region, service, signedHeaders, signature] = match as unknown as string[];
  if (accessKey !== FAKE_AWS.accessKeyId) return { type: 'UnrecognizedClientException', message: 'The security token included in the request is invalid.' };
  if (region !== FAKE_AWS.region || service !== 'bedrock') return { type: 'InvalidSignatureException', message: `Credential should be scoped to a valid region and service (got ${region}/${service}).` };
  const amzDate = String(request.headers['x-amz-date'] ?? '');
  const signedAt = Date.parse(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > 15 * 60_000 || amzDate.slice(0, 8) !== date) {
    return { type: 'InvalidSignatureException', message: 'Signature expired or the date does not match the credential scope.' };
  }
  const names = signedHeaders!.split(';');
  if (!names.includes('host') || !names.includes('x-amz-date')) return { type: 'InvalidSignatureException', message: 'host and x-amz-date must be signed.' };
  // The path as sent, each segment encoded once more (every service but S3).
  const canonicalPath = url.pathname.split('/').map(encodeRfc3986).join('/');
  const canonicalQuery = [...url.searchParams].map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).sort().join('&');
  const canonicalHeaders = names.map((name) => `${name}:${String(request.headers[name] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonical = ['POST', canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, createHash('sha256').update(body).digest('hex')].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  let key: Buffer = createHmac('sha256', `AWS4${FAKE_AWS.secretAccessKey}`).update(date!).digest();
  for (const part of [region!, service!, 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
  const expected = createHmac('sha256', key).update(toSign).digest('hex');
  if (expected !== signature) {
    return { type: 'InvalidSignatureException', message: 'The request signature we calculated does not match the signature you provided.' };
  }
  return undefined;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((block: any) => block.text ?? JSON.stringify(block.json ?? block)).join('');
  return JSON.stringify(content);
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => resolve(body));
  });
}
