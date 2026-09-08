/**
 * The `ma` commands.
 *
 * Grouped by resource. Read commands print a table (or JSON with `--json`);
 * write commands follow the plan/confirm/readback discipline from the
 * framework.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { MaError, validationError } from '@ma/core';
import { ManagedAgentClient } from '@ma/sdk';

import {
  formatDetail,
  formatTable,
  reportAmbiguous,
  reviewPlan,
  type Command,
  type CommandContext,
} from './framework.ts';

export interface CommandDeps {
  client: ManagedAgentClient;
}

function flag(context: CommandContext, name: string): string | undefined {
  const value = context.args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function requireFlag(context: CommandContext, name: string): string {
  const value = flag(context, name);
  if (!value) throw validationError(`--${name} is required`);
  return value;
}

function emit(context: CommandContext, value: unknown, table?: Record<string, unknown>[]): void {
  if (context.json) {
    context.out(JSON.stringify(value, null, 2));
    return;
  }
  context.out(table ? formatTable(table) : formatDetail(value as Record<string, unknown>));
}

/**
 * Read a value from a file rather than an argument.
 *
 * Secrets never go on the command line: argv is readable by every process on
 * the host and lands in shell history.
 */
async function readSecretFile(path: string): Promise<string> {
  const content = await readFile(path, 'utf8');
  const trimmed = content.replace(/\n$/, '');
  if (trimmed.length === 0) throw validationError(`${path} is empty`);
  return trimmed;
}

export function buildCommands(deps: CommandDeps): Command[] {
  const { client } = deps;

  return [
    // --- workspaces --------------------------------------------------------
    {
      name: 'workspace list',
      summary: 'List workspaces you can see',
      usage: 'ma workspace list [--limit N] [--json]',
      async run(context) {
        const page = await client.listWorkspaces({
          ...(flag(context, 'limit') ? { limit: Number(flag(context, 'limit')) } : {}),
        });
        emit(
          context,
          page,
          page.items.map((workspace) => ({
            id: workspace.id,
            slug: workspace.slug,
            name: workspace.name,
            status: workspace.status,
          })),
        );
        return 0;
      },
    },
    {
      name: 'workspace create',
      summary: 'Create a workspace',
      usage: 'ma workspace create --name NAME --slug SLUG [--yes]',
      mutates: true,
      async run(context) {
        const name = requireFlag(context, 'name');
        const slug = requireFlag(context, 'slug');
        const description = flag(context, 'description') ?? '';

        if (!reviewPlan(context, {
          action: 'Create a workspace',
          target: slug,
          changes: { name, slug, description },
        })) {
          return 0;
        }

        try {
          const { workspace } = await client.createWorkspace({ name, slug, description });
          // Read back rather than trusting the create response.
          const confirmed = await client.getWorkspace(workspace.id);
          emit(context, confirmed.workspace);
          return 0;
        } catch (error) {
          const failure = MaError.from(error);
          if (failure.category === 'timeout' || failure.category === 'unavailable') {
            return reportAmbiguous(context, failure, `create workspace '${slug}'`);
          }
          throw failure;
        }
      },
    },
    {
      name: 'workspace quota',
      summary: 'Show quota limits and current usage',
      usage: 'ma workspace quota --workspace ID',
      async run(context) {
        const quota = await client.getQuota(requireFlag(context, 'workspace'));
        emit(
          context,
          quota,
          quota.usage.map((entry) => ({
            dimension: entry.dimension,
            observed: entry.observed,
            limit: entry.limit,
            // The number an operator actually wants when deciding whether to
            // raise a limit.
            used: `${Math.round((entry.observed / Math.max(entry.limit, 1)) * 100)}%`,
          })),
        );
        return 0;
      },
    },

    // --- agents ------------------------------------------------------------
    {
      name: 'agent list',
      summary: 'List agents in a workspace',
      usage: 'ma agent list --workspace ID [--json]',
      async run(context) {
        const page = await client.listAgents(requireFlag(context, 'workspace'), {
          ...(flag(context, 'limit') ? { limit: Number(flag(context, 'limit')) } : {}),
        });
        emit(
          context,
          page,
          page.items.map((agent) => ({
            id: agent.id,
            name: agent.name,
            version: agent.latestVersion,
            production: agent.productionVersion ?? '-',
            status: agent.status,
          })),
        );
        return 0;
      },
    },
    {
      name: 'agent get',
      summary: 'Show one agent',
      usage: 'ma agent get --agent ID',
      async run(context) {
        const { agent } = await client.getAgent(requireFlag(context, 'agent'));
        emit(context, agent);
        return 0;
      },
    },
    {
      name: 'agent create',
      summary: 'Create an agent',
      usage: 'ma agent create --workspace ID --name NAME [--spec FILE] [--yes]',
      mutates: true,
      async run(context) {
        const workspaceId = requireFlag(context, 'workspace');
        const name = requireFlag(context, 'name');
        const specPath = flag(context, 'spec');
        const spec = specPath
          ? (JSON.parse(await readFile(specPath, 'utf8')) as Record<string, unknown>)
          : undefined;

        if (!reviewPlan(context, {
          action: 'Create an agent',
          target: `${workspaceId}/${name}`,
          changes: { name, spec: spec ? Object.keys(spec) : '(none)' },
        })) {
          return 0;
        }

        const { agent } = await client.createAgent(workspaceId, {
          name,
          ...(flag(context, 'description') ? { description: flag(context, 'description')! } : {}),
          ...(spec ? { spec } : {}),
        });
        emit(context, (await client.getAgent(agent.id)).agent);
        return 0;
      },
    },
    {
      name: 'agent update',
      summary: 'Update agent metadata, or move the production pin',
      usage: 'ma agent update --agent ID [--name N] [--production-version N] [--yes]',
      mutates: true,
      async run(context) {
        const agentId = requireFlag(context, 'agent');
        const production = flag(context, 'production-version');

        const patch: Parameters<typeof client.updateAgent>[1] = {
          ...(flag(context, 'name') ? { name: flag(context, 'name')! } : {}),
          ...(flag(context, 'description') ? { description: flag(context, 'description')! } : {}),
          ...(production ? { productionVersion: Number(production) } : {}),
        };
        if (Object.keys(patch).length === 0) {
          throw validationError('Nothing to update; pass --name, --description or --production-version');
        }

        // Moving the pin is how a rollback happens, so it is called out rather
        // than buried in a field list.
        const warnings = production
          ? [
              `New sessions will resolve version ${production}. Sessions already running keep the version they pinned.`,
            ]
          : [];

        if (!reviewPlan(context, {
          action: production ? 'Move the production pin' : 'Update agent metadata',
          target: agentId,
          changes: patch as Record<string, unknown>,
          warnings,
        })) {
          return 0;
        }

        await client.updateAgent(agentId, patch);
        emit(context, (await client.getAgent(agentId)).agent);
        return 0;
      },
    },
    {
      name: 'agent version create',
      summary: 'Publish a new agent version',
      usage: 'ma agent version create --agent ID --spec FILE [--replace] [--yes]',
      mutates: true,
      async run(context) {
        const agentId = requireFlag(context, 'agent');
        const spec = JSON.parse(await readFile(requireFlag(context, 'spec'), 'utf8')) as Record<
          string,
          unknown
        >;
        const replace = context.args.flags.get('replace') === true;

        const warnings = replace
          ? [
              'With --replace the version is a full snapshot: any field absent from the spec will be dropped rather than inherited.',
            ]
          : [];

        if (!reviewPlan(context, {
          action: replace ? 'Publish a replacement version' : 'Publish a version (merged over base)',
          target: agentId,
          changes: { fields: Object.keys(spec) },
          warnings,
        })) {
          return 0;
        }

        const result = await client.createVersion(agentId, {
          spec,
          replace,
          ...(flag(context, 'summary') ? { changeSummary: flag(context, 'summary')! } : {}),
        });

        if (!context.json) {
          context.out(`Published version ${result.version.version}.`);
          // Showing the diff is the point of returning one: an accidental drop
          // is visible immediately rather than at the next session.
          if (result.diff.added.length > 0) context.out(`  added:   ${result.diff.added.join(', ')}`);
          if (result.diff.changed.length > 0) context.out(`  changed: ${result.diff.changed.join(', ')}`);
          if (result.diff.removed.length > 0) context.out(`  removed: ${result.diff.removed.join(', ')}`);
        } else {
          context.out(JSON.stringify(result, null, 2));
        }
        return 0;
      },
    },
    {
      name: 'agent version list',
      summary: 'List an agent’s versions',
      usage: 'ma agent version list --agent ID',
      async run(context) {
        const page = await client.listVersions(requireFlag(context, 'agent'));
        emit(
          context,
          page,
          page.items.map((version) => ({
            version: version.version,
            model: version.model.modelId,
            summary: version.changeSummary || '-',
            createdAt: version.createdAt,
          })),
        );
        return 0;
      },
    },

    // --- sessions ----------------------------------------------------------
    {
      name: 'session create',
      summary: 'Start a session',
      usage: 'ma session create --agent ID [--title T] [--version N] [--yes]',
      mutates: true,
      async run(context) {
        const agentId = requireFlag(context, 'agent');
        const version = flag(context, 'version');

        if (!reviewPlan(context, {
          action: 'Start a session',
          target: agentId,
          changes: {
            agentVersion: version ?? '(latest or production pin)',
            title: flag(context, 'title') ?? '',
          },
        })) {
          return 0;
        }

        const { session } = await client.createSession({
          agentId,
          ...(flag(context, 'title') ? { title: flag(context, 'title')! } : {}),
          ...(version ? { agentVersion: Number(version) } : {}),
        });
        emit(context, session);
        return 0;
      },
    },
    {
      name: 'session list',
      summary: 'List sessions',
      // One of --workspace or --agent is required, not both optional: the API
      // scopes a session list by workspace so it can authorize it, and an
      // unscoped list would have to cross tenancy boundaries to answer.
      usage: 'ma session list (--workspace ID | --agent ID) [--statuses a,b]',
      async run(context) {
        if (!flag(context, 'workspace') && !flag(context, 'agent')) {
          context.err('Specify --workspace or --agent: a session list is scoped to one of them.');
          return 2;
        }
        const statuses = flag(context, 'statuses');
        const page = await client.listSessions({
          ...(flag(context, 'agent') ? { agentId: flag(context, 'agent')! } : {}),
          ...(flag(context, 'workspace') ? { workspaceId: flag(context, 'workspace')! } : {}),
          ...(statuses ? { statuses: statuses.split(',') as never } : {}),
        });
        emit(
          context,
          page,
          page.items.map((session) => ({
            id: session.id,
            status: session.status,
            version: session.resolvedVersion,
            turns: session.turnCount,
            tokens: session.usage.inputTokens + session.usage.outputTokens,
            title: session.title || '-',
          })),
        );
        return 0;
      },
    },
    {
      name: 'session send',
      summary: 'Send a prompt to a session',
      usage: 'ma session send --session ID --prompt-file FILE [--yes]',
      mutates: true,
      async run(context) {
        const sessionId = requireFlag(context, 'session');
        // From a file, not an argument: a prompt can be long, can contain
        // anything, and should not land in shell history.
        const prompt = await readFile(requireFlag(context, 'prompt-file'), 'utf8');

        if (!reviewPlan(context, {
          action: 'Send a prompt',
          target: sessionId,
          changes: { characters: prompt.length, preview: prompt.slice(0, 120) },
        })) {
          return 0;
        }

        const result = await client.prompt(sessionId, prompt);
        if (!context.json) context.out(`Accepted ${result.accepted} event(s).`);
        else context.out(JSON.stringify(result, null, 2));
        return 0;
      },
    },
    {
      name: 'session watch',
      summary: 'Follow a session’s events, resuming automatically',
      usage: 'ma session watch --session ID [--from-seq N] [--types tool.,turn.]',
      async run(context) {
        const sessionId = requireFlag(context, 'session');
        const types = flag(context, 'types');
        const controller = new AbortController();

        // Ctrl-C should stop the stream cleanly rather than leaving a partial
        // line and a dangling connection.
        const onSignal = (): void => controller.abort();
        process.once('SIGINT', onSignal);

        try {
          for await (const event of client.streamEvents(sessionId, {
            ...(flag(context, 'from-seq') ? { fromSeq: Number(flag(context, 'from-seq')) } : {}),
            ...(types ? { types: types.split(',') } : {}),
            signal: controller.signal,
          })) {
            if (context.json) {
              context.out(JSON.stringify(event));
            } else {
              context.out(`[${String(event.seq).padStart(5)}] ${event.type} ${summarize(event)}`);
            }
          }
        } finally {
          process.removeListener('SIGINT', onSignal);
        }
        return 0;
      },
    },
    {
      name: 'session events',
      summary: 'Read a session’s persisted events',
      usage: 'ma session events --session ID [--from-seq N] [--limit N]',
      async run(context) {
        const result = await client.readEvents(requireFlag(context, 'session'), {
          ...(flag(context, 'from-seq') ? { fromSeq: Number(flag(context, 'from-seq')) } : {}),
          ...(flag(context, 'limit') ? { limit: Number(flag(context, 'limit')) } : {}),
        });
        emit(
          context,
          result,
          result.events.map((event) => ({
            seq: event.seq,
            type: event.type,
            turn: event.turn ?? '-',
            summary: summarize(event),
          })),
        );
        return 0;
      },
    },
    {
      name: 'session terminate',
      summary: 'End a session and release its sandbox',
      usage: 'ma session terminate --session ID --reason TEXT [--yes]',
      mutates: true,
      async run(context) {
        const sessionId = requireFlag(context, 'session');
        const reason = flag(context, 'reason') ?? '';

        if (!reviewPlan(context, {
          action: 'Terminate a session',
          target: sessionId,
          changes: { reason },
          warnings: ['This is irreversible. The sandbox is released and the session cannot resume.'],
        })) {
          return 0;
        }

        const { session } = await client.terminate(sessionId, reason);
        emit(context, session);
        return 0;
      },
    },

    // --- credentials -------------------------------------------------------
    {
      name: 'credential create',
      summary: 'Store a credential (value read from a file)',
      usage: 'ma credential create --workspace ID --name N --type T --value-file FILE [--yes]',
      mutates: true,
      async run(context) {
        const workspaceId = requireFlag(context, 'workspace');
        const name = requireFlag(context, 'name');
        const type = requireFlag(context, 'type');
        const value = await readSecretFile(requireFlag(context, 'value-file'));

        if (!reviewPlan(context, {
          action: 'Store a credential',
          target: `${workspaceId}/${name}`,
          // The plan shows the shape, never the value.
          changes: { name, type, valueLength: value.length },
          warnings: ['The value is write-only: it can never be read back through the API.'],
        })) {
          return 0;
        }

        const { credential } = await client.createCredential(workspaceId, {
          ownerType: (flag(context, 'owner-type') ?? 'workspace') as never,
          type: type as never,
          name,
          value,
        });
        emit(context, credential);
        return 0;
      },
    },
    {
      name: 'credential list',
      summary: 'List credential metadata (never values)',
      usage: 'ma credential list --workspace ID',
      async run(context) {
        const page = await client.listCredentials(requireFlag(context, 'workspace'));
        emit(
          context,
          page,
          page.items.map((credential) => ({
            id: credential.id,
            name: credential.name,
            type: credential.type,
            status: credential.status,
            expiresAt: credential.expiresAt ?? '-',
          })),
        );
        return 0;
      },
    },

    {
      name: 'session renew',
      summary: 'Extend a session’s TTL so it is not reaped mid-work',
      usage: 'ma session renew --session ID --ttl SECONDS [--yes]',
      mutates: true,
      async run(context) {
        const sessionId = requireFlag(context, 'session');
        const ttlSeconds = Number(requireFlag(context, 'ttl'));
        if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60) {
          context.err('--ttl must be a whole number of seconds, at least 60.');
          return 2;
        }

        if (!reviewPlan(context, {
          action: 'Extend a session’s TTL',
          target: sessionId,
          changes: { ttlSeconds },
        })) {
          return 0;
        }

        const { session } = await client.renew(sessionId, ttlSeconds);
        emit(context, session);
        return 0;
      },
    },

    // --- artifacts -----------------------------------------------------------

    {
      name: 'artifact list',
      summary: 'List files agents produced',
      usage: 'ma artifact list --workspace ID [--session ID] [--json]',
      async run(context) {
        const page = await client.listArtifacts(requireFlag(context, 'workspace'), {
          ...(flag(context, 'session') ? { sessionId: flag(context, 'session')! } : {}),
        });
        emit(
          context,
          page,
          page.items.map((artifact) => ({
            id: artifact.id,
            path: artifact.path,
            type: artifact.contentType,
            bytes: artifact.sizeBytes,
            status: artifact.status,
          })),
        );
        return 0;
      },
    },

    {
      name: 'artifact get',
      summary: 'Download an artifact to a file',
      usage: 'ma artifact get --artifact ID --out FILE',
      async run(context) {
        const artifactId = requireFlag(context, 'artifact');
        const out = requireFlag(context, 'out');
        const bytes = await client.downloadArtifact(artifactId);
        await writeFile(out, bytes);
        // Written to a file rather than stdout: an artifact is arbitrary bytes
        // an agent chose, and piping a PNG or a terminal escape sequence into
        // the operator's shell is not something to do by default.
        context.out(`Wrote ${bytes.byteLength} bytes to ${out}`);
        return 0;
      },
    },

    {
      name: 'artifact delete',
      summary: 'Delete an artifact’s content, keeping its record',
      usage: 'ma artifact delete --artifact ID --reason TEXT [--yes]',
      mutates: true,
      async run(context) {
        const artifactId = requireFlag(context, 'artifact');
        const reason = flag(context, 'reason') ?? '';

        if (!reviewPlan(context, {
          action: 'Delete an artifact’s content',
          target: artifactId,
          changes: { reason },
          warnings: ['The bytes are gone for good. The record survives as `purged`.'],
        })) {
          return 0;
        }

        const { artifact } = await client.deleteArtifact(artifactId, reason);
        emit(context, artifact);
        return 0;
      },
    },

    // --- memories ------------------------------------------------------------

    {
      name: 'memory list',
      summary: 'List what a workspace and its agents remember',
      usage: 'ma memory list --workspace ID [--agent ID] [--injectable-only] [--json]',
      async run(context) {
        const page = await client.listMemories(requireFlag(context, 'workspace'), {
          ...(flag(context, 'agent') ? { agentId: flag(context, 'agent')! } : {}),
          ...(context.args.flags.get('injectable-only') === true ? { injectableOnly: true } : {}),
        });
        emit(
          context,
          page,
          page.items.map((memory) => ({
            id: memory.id,
            scope: memory.scope,
            // Origin and injectable are the two columns that matter: they say
            // whether a line can reach the system prompt, and who put it there.
            origin: memory.origin,
            injected: memory.injectable ? 'yes' : 'no',
            content: memory.content.slice(0, 60),
          })),
        );
        return 0;
      },
    },

    {
      name: 'memory add',
      summary: 'Write a memory as a human',
      usage: 'ma memory add --workspace ID --content TEXT [--agent ID] [--not-injectable] [--yes]',
      mutates: true,
      async run(context) {
        const workspaceId = requireFlag(context, 'workspace');
        const content = requireFlag(context, 'content');
        const agentId = flag(context, 'agent');
        const injectable = context.args.flags.get('not-injectable') !== true;

        if (!reviewPlan(context, {
          action: 'Write a memory',
          target: workspaceId,
          changes: {
            content,
            scope: agentId ? `agent ${agentId}` : 'workspace',
            'in system prompt': injectable ? 'yes' : 'no',
          },
        })) {
          return 0;
        }

        const memory = await client.createMemory(workspaceId, {
          content,
          ...(agentId ? { scope: 'agent' as const, agentId } : {}),
          injectable,
        });
        emit(context, memory);
        return 0;
      },
    },

    {
      name: 'memory promote',
      summary: 'Allow a memory into the system prompt, or withdraw it',
      usage: 'ma memory promote --memory ID [--withdraw] [--yes]',
      mutates: true,
      async run(context) {
        const memoryId = requireFlag(context, 'memory');
        const injectable = context.args.flags.get('withdraw') !== true;

        if (!reviewPlan(context, {
          action: injectable
            ? 'Allow a memory into the system prompt'
            : 'Withdraw a memory from the system prompt',
          target: memoryId,
          changes: { injectable: injectable ? 'yes' : 'no' },
          warnings: injectable
            ? [
                'Check the memory’s origin first. Agent-authored text in a system prompt ' +
                  'is an instruction the agent wrote for itself.',
              ]
            : [],
        })) {
          return 0;
        }

        const memory = await client.promoteMemory(memoryId, injectable);
        emit(context, memory);
        return 0;
      },
    },

    {
      name: 'memory forget',
      summary: 'Delete a memory',
      usage: 'ma memory forget --memory ID --reason TEXT [--yes]',
      mutates: true,
      async run(context) {
        const memoryId = requireFlag(context, 'memory');
        const reason = flag(context, 'reason') ?? '';

        if (!reviewPlan(context, {
          action: 'Forget a memory',
          target: memoryId,
          changes: { reason },
        })) {
          return 0;
        }

        await client.forgetMemory(memoryId, reason);
        context.out(`Forgot ${memoryId}`);
        return 0;
      },
    },

    // --- misc --------------------------------------------------------------
    {
      name: 'model list',
      summary: 'List available models',
      usage: 'ma model list [--workspace ID]',
      async run(context) {
        const { models } = await client.listModels(flag(context, 'workspace'));
        emit(
          context,
          { models },
          models.map((model) => ({
            id: model.id,
            context: model.contextWindowTokens,
            maxOutput: model.maxOutputTokens,
            security: model.securityLevel || '-',
          })),
        );
        return 0;
      },
    },
    {
      name: 'health',
      summary: 'Check that the API is reachable',
      usage: 'ma health',
      async run(context) {
        emit(context, await client.health());
        return 0;
      },
    },
  ];
}

/** One-line summary of an event, for the watch and events commands. */
function summarize(event: { type: string; payload: unknown }): string {
  const payload = event.payload as Record<string, unknown>;
  if (!payload) return '';

  if (typeof payload.text === 'string') return truncate(payload.text);
  if (typeof payload.toolName === 'string') return String(payload.toolName);
  if (typeof payload.reason === 'string') return String(payload.reason);
  if (typeof payload.error === 'object' && payload.error) {
    return String((payload.error as { message?: string }).message ?? '');
  }
  return '';
}

function truncate(text: string, max = 100): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}
