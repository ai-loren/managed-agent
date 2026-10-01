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
  terminalSafe,
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
export async function readSecretFile(path: string): Promise<string> {
  const content = await readFile(path, 'utf8');
  // Strip the whole trailing line-ending / trailing blank lines, not a single
  // `\n`: a Windows-authored (CRLF) file left a stray `\r`, and a trailing blank
  // line left an embedded `\n`, baked silently into a write-only credential —
  // undiagnosable because the value can never be read back, surfacing only as an
  // opaque 401/403 from the third party. `trimEnd` handles CRLF and blank lines;
  // a credential value with intentional trailing whitespace is not a real case.
  const trimmed = content.trimEnd();
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
      usage: 'ma workspace create --name NAME --slug SLUG [--description TEXT] [--yes]',
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
      usage: 'ma agent list --workspace ID [--limit N] [--json]',
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
      usage: 'ma agent create --workspace ID --name NAME [--spec FILE] [--description TEXT] [--yes]',
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
      usage: 'ma agent update --agent ID [--name N] [--description TEXT] [--production-version N] [--yes]',
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
      usage: 'ma agent version create --agent ID --spec FILE [--summary TEXT] [--replace] [--yes]',
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
              context.out(terminalSafe(`[${String(event.seq).padStart(5)}] ${event.type} ${summarize(event)}`));
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
      usage: 'ma credential create --workspace ID --name N --type T --value-file FILE [--owner-type T] [--owner-id ID] [--yes]',
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

        const ownerType = flag(context, 'owner-type') ?? 'workspace';
        const ownerId = flag(context, 'owner-id');
        // A non-workspace scope is meaningless without the id it scopes to; catch
        // it here rather than creating a credential scoped to an owner with no id.
        if (ownerType !== 'workspace' && !ownerId) {
          throw validationError(`--owner-id is required when --owner-type is '${ownerType}'`);
        }

        const { credential } = await client.createCredential(workspaceId, {
          ownerType: ownerType as never,
          ...(ownerId ? { ownerId } : {}),
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
    {
      name: 'session model',
      summary: 'Choose the model this session calls (this session only)',
      usage: 'ma session model --session ID [--model ID | --clear] [--yes]',
      mutates: true,
      async run(context) {
        const sessionId = requireFlag(context, 'session');
        const clear = context.args.flags.get('clear') === true || context.args.flags.get('clear') === 'true';
        const modelId = flag(context, 'model');
        if (!clear && !modelId) {
          context.err('Provide --model ID to choose a model, or --clear to return to the version’s model.');
          return 2;
        }
        if (clear && modelId) {
          context.err('--model and --clear are mutually exclusive.');
          return 2;
        }

        // Same plan/confirm discipline as every other mutation. The server
        // validates the id against the catalogue — a model this workspace may not
        // use is refused there whatever this plan says.
        if (!reviewPlan(context, {
          action: 'Change the model for this session',
          target: sessionId,
          changes: clear ? { model: '(back to the version’s model)' } : { model: modelId },
        })) {
          return 0;
        }

        const { session } = await client.setSessionModel(sessionId, clear ? null : (modelId ?? null));
        emit(context, {
          session: session.id,
          model: session.modelOverride ?? '(version default)',
        });
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

    // --- templates ---------------------------------------------------------
    {
      name: 'template list',
      summary: 'List the agent templates a workspace can instantiate',
      usage: 'ma template list --workspace ID [--category NAME] [--json]',
      async run(context) {
        const page = await client.listTemplates(requireFlag(context, 'workspace'), {
          ...(flag(context, 'category') ? { category: flag(context, 'category')! } : {}),
        });
        emit(
          context,
          page,
          page.items.map((template) => ({
            id: template.id,
            name: template.name,
            category: template.category,
            builtin: template.builtin ? 'yes' : 'no',
            variables: template.variables.map((variable) => variable.key).join(', '),
          })),
        );
        return 0;
      },
    },
    {
      name: 'template get',
      summary: 'Show one template',
      usage: 'ma template get --template ID',
      async run(context) {
        const { template } = await client.getTemplate(requireFlag(context, 'template'));
        emit(context, template);
        return 0;
      },
    },
    {
      name: 'template create',
      summary: 'Author a workspace template from a spec file',
      usage: 'ma template create --workspace ID --name NAME --spec FILE [--description TEXT] [--category NAME] [--variables FILE] [--yes]',
      mutates: true,
      async run(context) {
        const workspaceId = requireFlag(context, 'workspace');
        const name = requireFlag(context, 'name');
        const spec = JSON.parse(await readFile(requireFlag(context, 'spec'), 'utf8')) as Record<
          string,
          unknown
        >;
        const variablesPath = flag(context, 'variables');
        const variables = variablesPath
          ? (JSON.parse(await readFile(variablesPath, 'utf8')) as never[])
          : undefined;

        if (!reviewPlan(context, {
          action: 'Author a template',
          target: `${workspaceId}/${name}`,
          changes: {
            name,
            spec: Object.keys(spec),
            variables: variables ? variables.length : 0,
          },
        })) {
          return 0;
        }

        const template = await client.createTemplate(workspaceId, {
          name,
          ...(flag(context, 'description') ? { description: flag(context, 'description')! } : {}),
          ...(flag(context, 'category') ? { category: flag(context, 'category')! } : {}),
          spec,
          ...(variables ? { variables } : {}),
        });
        emit(context, template);
        return 0;
      },
    },
    {
      name: 'template delete',
      summary: 'Delete a workspace template',
      usage: 'ma template delete --template ID [--yes]',
      mutates: true,
      async run(context) {
        const templateId = requireFlag(context, 'template');
        if (!reviewPlan(context, { action: 'Delete a template', target: templateId, changes: {} })) {
          return 0;
        }
        await client.deleteTemplate(templateId);
        context.out(`Deleted ${templateId}`);
        return 0;
      },
    },
    {
      name: 'template instantiate',
      summary: 'Create an agent from a template',
      usage: 'ma template instantiate --workspace ID --template ID [--name NAME] [--variables FILE] [--yes]',
      mutates: true,
      async run(context) {
        const workspaceId = requireFlag(context, 'workspace');
        const templateId = requireFlag(context, 'template');
        const variablesPath = flag(context, 'variables');
        const variables = variablesPath
          ? (JSON.parse(await readFile(variablesPath, 'utf8')) as Record<string, unknown>)
          : undefined;

        if (!reviewPlan(context, {
          action: 'Create an agent from a template',
          target: `${workspaceId} ← ${templateId}`,
          changes: {
            name: flag(context, 'name') ?? '(template default)',
            variables: variables ? Object.keys(variables) : '(none)',
          },
        })) {
          return 0;
        }

        const agent = await client.instantiateTemplate(workspaceId, templateId, {
          ...(flag(context, 'name') ? { agentName: flag(context, 'name')! } : {}),
          ...(variables ? { variables } : {}),
        });
        emit(context, (await client.getAgent(agent.id)).agent);
        return 0;
      },
    },

    // --- connectors --------------------------------------------------------
    {
      name: 'connector list',
      summary: 'List connectors in a workspace',
      usage: 'ma connector list --workspace ID [--type T] [--limit N] [--json]',
      async run(context) {
        const page = await client.listConnectors(requireFlag(context, 'workspace'), {
          ...(flag(context, 'type') ? { type: flag(context, 'type') } : {}),
          ...(flag(context, 'limit') ? { limit: Number(flag(context, 'limit')) } : {}),
        });
        emit(
          context,
          page,
          page.items.map((connector) => ({
            id: connector.id,
            type: connector.type,
            name: connector.name,
            status: connector.status,
            externalKey: connector.externalKey,
            agentId: connector.agentId ?? '-',
          })),
        );
        return 0;
      },
    },
    {
      name: 'connector get',
      summary: 'Show one connector',
      usage: 'ma connector get --connector ID [--json]',
      async run(context) {
        const { connector } = await client.getConnector(requireFlag(context, 'connector'));
        emit(context, connector);
        return 0;
      },
    },
    {
      name: 'connector create',
      summary: 'Create a connector (starts as draft; activate separately)',
      usage: 'ma connector create --workspace ID --type T --name N --external-key K [--agent ID] [--session-policy P] [--config FILE] [--secret-credential ID] [--yes]',
      mutates: true,
      async run(context) {
        const workspaceId = requireFlag(context, 'workspace');
        const type = requireFlag(context, 'type');
        const name = requireFlag(context, 'name');
        const externalKey = requireFlag(context, 'external-key');
        const configPath = flag(context, 'config');
        const config = configPath
          ? (JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>)
          : undefined;

        if (!reviewPlan(context, {
          action: 'Create a connector',
          target: `${workspaceId}/${name}`,
          changes: {
            type,
            externalKey,
            agentId: flag(context, 'agent') ?? '(none)',
            sessionPolicy: flag(context, 'session-policy') ?? 'new_per_event',
            config: config ? Object.keys(config) : '(none)',
          },
          warnings: ['The connector is created disabled (draft). Activate it with `ma connector activate`.'],
        })) {
          return 0;
        }

        const connector = await client.createConnector(workspaceId, {
          type: type as never,
          name,
          externalKey,
          ...(flag(context, 'agent') ? { agentId: flag(context, 'agent')! } : {}),
          ...(flag(context, 'session-policy')
            ? { sessionPolicy: flag(context, 'session-policy') as never }
            : {}),
          ...(config ? { config } : {}),
          ...(flag(context, 'secret-credential')
            ? { secretCredentialId: flag(context, 'secret-credential')! }
            : {}),
        });
        emit(context, connector);
        return 0;
      },
    },
    {
      name: 'connector update',
      summary: 'Edit a connector’s settings',
      usage: 'ma connector update --connector ID [--name N] [--agent ID] [--session-policy P] [--config FILE] [--secret-credential ID] [--yes]',
      mutates: true,
      async run(context) {
        const connectorId = requireFlag(context, 'connector');
        const configPath = flag(context, 'config');
        const config = configPath
          ? (JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>)
          : undefined;

        const patch = {
          ...(flag(context, 'name') ? { name: flag(context, 'name')! } : {}),
          ...(flag(context, 'agent') ? { agentId: flag(context, 'agent')! } : {}),
          ...(flag(context, 'session-policy')
            ? { sessionPolicy: flag(context, 'session-policy') as never }
            : {}),
          ...(config ? { config } : {}),
          ...(flag(context, 'secret-credential')
            ? { secretCredentialId: flag(context, 'secret-credential')! }
            : {}),
        };
        if (Object.keys(patch).length === 0) {
          context.err('Nothing to update: pass at least one of --name, --agent, --session-policy, --config, --secret-credential.');
          return 2;
        }

        if (!reviewPlan(context, {
          action: 'Update a connector',
          target: connectorId,
          changes: { ...patch, config: config ? Object.keys(config) : undefined },
        })) {
          return 0;
        }

        const connector = await client.updateConnector(connectorId, patch);
        emit(context, connector);
        return 0;
      },
    },
    {
      name: 'connector activate',
      summary: 'Validate and put a connector on the network',
      usage: 'ma connector activate --connector ID [--yes]',
      mutates: true,
      async run(context) {
        const connectorId = requireFlag(context, 'connector');
        if (!reviewPlan(context, {
          action: 'Activate a connector',
          target: connectorId,
          changes: { status: 'active' },
          warnings: ['This puts the connector on the network: it will start accepting deliveries and running agents.'],
        })) {
          return 0;
        }
        const connector = await client.activateConnector(connectorId);
        emit(context, connector);
        return 0;
      },
    },
    {
      name: 'connector status',
      summary: 'Set a connector’s status (disabled/archived/draft/active)',
      usage: 'ma connector status --connector ID --set STATUS [--reason TEXT] [--yes]',
      mutates: true,
      async run(context) {
        const connectorId = requireFlag(context, 'connector');
        const status = requireFlag(context, 'set');
        if (!reviewPlan(context, {
          action: 'Change a connector’s status',
          target: connectorId,
          changes: { status },
        })) {
          return 0;
        }
        const connector = await client.setConnectorStatus(
          connectorId,
          status as never,
          flag(context, 'reason') ?? '',
        );
        emit(context, connector);
        return 0;
      },
    },
    {
      name: 'connector run',
      summary: 'Fire a schedule now, without waiting for its cron',
      usage: 'ma connector run --connector ID [--yes]',
      mutates: true,
      async run(context) {
        const connectorId = requireFlag(context, 'connector');
        if (!reviewPlan(context, {
          action: 'Run a schedule on demand',
          target: connectorId,
          changes: {},
        })) {
          return 0;
        }
        const result = await client.runConnector(connectorId);
        emit(context, result);
        return 0;
      },
    },
    {
      name: 'connector next-fire',
      summary: 'Show when a schedule will next fire',
      usage: 'ma connector next-fire --connector ID [--json]',
      async run(context) {
        const result = await client.nextFire(requireFlag(context, 'connector'));
        emit(context, result);
        return 0;
      },
    },
    {
      name: 'connector receipts',
      summary: 'List a connector’s delivery receipts',
      usage: 'ma connector receipts --connector ID [--statuses S,S] [--limit N] [--json]',
      async run(context) {
        const statuses = flag(context, 'statuses');
        const page = await client.listReceipts(requireFlag(context, 'connector'), {
          ...(statuses ? { statuses: statuses.split(',') } : {}),
          ...(flag(context, 'limit') ? { limit: Number(flag(context, 'limit')) } : {}),
        });
        emit(
          context,
          page,
          page.items.map((receipt) => ({
            id: receipt.id,
            status: receipt.status,
            attempt: receipt.attempt,
            sessionId: receipt.sessionId ?? '-',
            externalEventId: receipt.externalEventId,
            createdAt: receipt.createdAt,
          })),
        );
        return 0;
      },
    },
    {
      name: 'receipt retry',
      summary: 'Replay a terminal delivery as a fresh receipt',
      usage: 'ma receipt retry --receipt ID [--reason TEXT] [--yes]',
      mutates: true,
      async run(context) {
        const receiptId = requireFlag(context, 'receipt');
        if (!reviewPlan(context, {
          action: 'Replay a delivery',
          target: receiptId,
          changes: { reason: flag(context, 'reason') ?? 'replayed by an operator' },
        })) {
          return 0;
        }
        const result = await client.retryReceipt(receiptId, flag(context, 'reason') ?? '');
        emit(context, result);
        return 0;
      },
    },

    // --- datasets ----------------------------------------------------------
    {
      name: 'dataset list',
      summary: 'List knowledge-base datasets in a workspace',
      usage: 'ma dataset list --workspace ID [--limit N] [--json]',
      async run(context) {
        const page = await client.listDatasets(requireFlag(context, 'workspace'), {
          ...(flag(context, 'limit') ? { limit: Number(flag(context, 'limit')) } : {}),
        });
        emit(
          context,
          page,
          page.items.map((dataset) => ({
            id: dataset.id,
            name: dataset.name,
            status: dataset.status,
            documents: dataset.documentCount,
            chunks: dataset.chunkCount,
          })),
        );
        return 0;
      },
    },
    {
      name: 'dataset create',
      summary: 'Create a knowledge-base dataset',
      usage: 'ma dataset create --workspace ID --name N [--description TEXT] [--embedding-model M] [--yes]',
      mutates: true,
      async run(context) {
        const workspaceId = requireFlag(context, 'workspace');
        const name = requireFlag(context, 'name');
        if (!reviewPlan(context, {
          action: 'Create a dataset',
          target: `${workspaceId}/${name}`,
          changes: { name, embeddingModel: flag(context, 'embedding-model') ?? '(default)' },
        })) {
          return 0;
        }
        const dataset = await client.createDataset(workspaceId, {
          name,
          ...(flag(context, 'description') ? { description: flag(context, 'description')! } : {}),
          ...(flag(context, 'embedding-model')
            ? { embeddingModel: flag(context, 'embedding-model')! }
            : {}),
        });
        emit(context, dataset);
        return 0;
      },
    },
    {
      name: 'dataset add-document',
      summary: 'Add a document to a dataset (content read from a file)',
      usage: 'ma dataset add-document --dataset ID --name N --content-file FILE [--content-type T] [--sync-rule R] [--yes]',
      mutates: true,
      async run(context) {
        const datasetId = requireFlag(context, 'dataset');
        const name = requireFlag(context, 'name');
        const content = await readFile(requireFlag(context, 'content-file'), 'utf8');

        if (!reviewPlan(context, {
          action: 'Add a document',
          target: `${datasetId}/${name}`,
          changes: {
            name,
            bytes: Buffer.byteLength(content, 'utf8'),
            contentType: flag(context, 'content-type') ?? 'text/plain',
            syncRule: flag(context, 'sync-rule') ?? 'manual',
          },
          warnings: ['An agent bound to this dataset will read and trust this document’s content.'],
        })) {
          return 0;
        }

        const document = await client.addDocument(datasetId, {
          name,
          content,
          source: 'inline',
          ...(flag(context, 'content-type') ? { contentType: flag(context, 'content-type')! } : {}),
          ...(flag(context, 'sync-rule') ? { syncRule: flag(context, 'sync-rule') as never } : {}),
        });
        emit(context, document);
        return 0;
      },
    },
    {
      name: 'dataset documents',
      summary: 'List documents in a dataset',
      usage: 'ma dataset documents --dataset ID [--status S] [--limit N] [--json]',
      async run(context) {
        const page = await client.listDocuments(requireFlag(context, 'dataset'), {
          ...(flag(context, 'status') ? { status: flag(context, 'status') } : {}),
          ...(flag(context, 'limit') ? { limit: Number(flag(context, 'limit')) } : {}),
        });
        emit(
          context,
          page,
          page.items.map((document) => ({
            id: document.id,
            name: document.name,
            status: document.status,
            source: document.source,
            chunks: document.chunkCount,
          })),
        );
        return 0;
      },
    },
    {
      name: 'dataset bind',
      summary: 'Bind datasets to an agent, exposing them to its retrieval tool',
      usage: 'ma dataset bind --agent ID --datasets ID,ID [--yes]',
      mutates: true,
      async run(context) {
        const agentId = requireFlag(context, 'agent');
        const datasetIds = requireFlag(context, 'datasets').split(',').filter(Boolean);
        if (datasetIds.length === 0) {
          context.err('--datasets must list at least one dataset id.');
          return 2;
        }
        if (!reviewPlan(context, {
          action: 'Bind datasets to an agent',
          target: agentId,
          changes: { datasetIds },
          warnings: ['This changes what the agent can read through retrieval.'],
        })) {
          return 0;
        }
        const result = await client.bindDatasets(agentId, datasetIds);
        emit(context, result);
        return 0;
      },
    },

    // --- audit -------------------------------------------------------------
    {
      name: 'audit list',
      summary: 'List a workspace’s audit trail',
      usage: 'ma audit list --workspace ID [--action A] [--limit N] [--json]',
      async run(context) {
        const page = await client.listAudit(requireFlag(context, 'workspace'), {
          ...(flag(context, 'action') ? { action: flag(context, 'action') } : {}),
          ...(flag(context, 'limit') ? { limit: Number(flag(context, 'limit')) } : {}),
        });
        emit(
          context,
          page,
          page.items.map((entry) => ({
            at: entry.at,
            action: entry.action,
            outcome: entry.outcome,
            principal: entry.principalId,
            resource: entry.resourceId || '-',
          })),
        );
        return 0;
      },
    },

    // --- misc --------------------------------------------------------------
    {
      name: 'model list',
      summary: 'List models registered on this platform',
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
            tools: model.capabilities.tools ? 'yes' : 'no',
            security: model.securityLevel || '-',
          })),
        );
        return 0;
      },
    },
    {
      name: 'model free',
      summary: 'List the free models the provider offers (tools-capable first)',
      usage: 'ma model free [--all]',
      async run(context) {
        // Discovered live from the provider, not the local catalogue: the point is
        // to see what *could* be added, not only what already was. By default we
        // show only tools-capable models, since a model without function-calling
        // cannot drive an agent's tool loop; --all shows every free model.
        const { models } = await client.listFreeModels();
        const showAll = context.args.flags.get('all') === true || context.args.flags.get('all') === 'true';
        const shown = showAll ? models : models.filter((m) => m.tools);
        emit(
          context,
          { models: shown },
          shown.map((m) => ({
            id: m.id,
            tools: m.tools ? 'yes' : 'no',
            context: m.contextLength || '-',
            name: m.name,
          })),
        );
        return 0;
      },
    },
    {
      name: 'model free-add',
      summary: 'Register a free model into the platform catalogue',
      usage: 'ma model free-add --model ID [--yes]',
      mutates: true,
      async run(context) {
        const modelId = requireFlag(context, 'model');

        // Same plan/confirm discipline as every other mutation. The server
        // re-checks the id against the provider's live free catalogue, so a typo
        // or a paid id is refused there whatever this plan says.
        if (
          !reviewPlan(context, {
            action: 'Register a free model',
            target: modelId,
            changes: { catalogue: 'add, or refresh if already registered', cost: 'free (zero-priced)' },
            warnings: [
              'Re-registering refreshes the name, context window and capabilities from the provider; whether the model is enabled and which workspaces may use it are kept.',
            ],
          })
        ) {
          return 0;
        }

        const { model } = await client.registerFreeModel(modelId);
        emit(context, { model }, [{ id: model.id, registered: 'yes' }]);
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
