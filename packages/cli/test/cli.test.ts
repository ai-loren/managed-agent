/**
 * CLI tests.
 *
 * The mutation discipline is what these exist for. A command that quietly
 * applies a change without `--yes`, or that retries an ambiguous write, is the
 * failure this whole design is built to prevent.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MaError } from '@ma/core';

import {
  buildCommands,
  formatTable,
  knownFlags,
  main,
  parseArgs,
  readSecretFile,
  reportAmbiguous,
  reportError,
  reviewPlan,
  suggestFlag,
  unknownFlags,
  type Command,
  type CommandContext,
} from '../src/index.ts';

/** A context that records what would have been printed. */
function context(overrides: Partial<CommandContext> = {}): CommandContext & {
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    args: parseArgs([]),
    json: false,
    confirmed: false,
    out: (text: string) => void stdout.push(text),
    err: (text: string) => void stderr.push(text),
    stdout,
    stderr,
    ...overrides,
  } as CommandContext & { stdout: string[]; stderr: string[] };
}

describe('argument parsing', () => {
  test('handles the flag forms a user actually types', () => {
    const args = parseArgs(['agent', 'create', '--name', 'Bot', '--yes', '--limit=10', '-j']);
    assert.deepEqual(args.positional, ['agent', 'create']);
    assert.equal(args.flags.get('name'), 'Bot');
    assert.equal(args.flags.get('yes'), true);
    assert.equal(args.flags.get('limit'), '10');
    assert.equal(args.flags.get('j'), true);
  });

  test('treats a flag followed by another LONG flag as a boolean', () => {
    const args = parseArgs(['--json', '--limit', '5']);
    assert.equal(args.flags.get('json'), true);
    assert.equal(args.flags.get('limit'), '5');
  });

  test('takes a flag value that begins with a dash (a token or negative number)', () => {
    // `--token -sk_live_ABC` and `--from-seq -1` are values, not booleans. Treating
    // a single-dash next token as "another flag" dropped the value AND echoed the
    // token as an unknown flag to stderr — leaking a secret the CLI refused to
    // accept. Only a `--`-prefixed token (or `--`) terminates a flag's value.
    const tok = parseArgs(['workspace', 'list', '--token', '-sk_live_ABC']);
    assert.equal(tok.flags.get('token'), '-sk_live_ABC', 'the dash-prefixed value is captured');
    assert.equal(tok.flags.has('sk_live_ABC'), false, 'it is not turned into a stray unknown flag');

    const neg = parseArgs(['session', 'events', '--from-seq', '-1']);
    assert.equal(neg.flags.get('from-seq'), '-1');

    // A long flag still terminates the previous flag's value (stays boolean).
    const bool = parseArgs(['--json', '--token', 'X']);
    assert.equal(bool.flags.get('json'), true);
    assert.equal(bool.flags.get('token'), 'X');
  });

  test('everything after -- is positional', () => {
    // So a prompt containing something flag-shaped survives intact.
    const args = parseArgs(['session', 'send', '--', '--not-a-flag', 'text']);
    assert.deepEqual(args.positional, ['session', 'send', '--not-a-flag', 'text']);
  });
});

describe('reading a secret from a file', () => {
  test('strips a trailing newline, CRLF, or trailing blank line, not just one \\n', async () => {
    // A credential value is write-only: a stray trailing \r (CRLF file) or \n
    // baked into it is undiagnosable — it surfaces only as an opaque third-party
    // 401. Stripping one \n left the \r on a CRLF file and an embedded \n on a
    // trailing blank line; trimEnd handles both.
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'ma-secret-'));

    const lf = join(dir, 'lf');
    await writeFile(lf, 'sk-abc\n');
    assert.equal(await readSecretFile(lf), 'sk-abc');

    const crlf = join(dir, 'crlf');
    await writeFile(crlf, 'sk-abc\r\n');
    assert.equal(await readSecretFile(crlf), 'sk-abc', 'no stray \\r from a CRLF file');

    const blank = join(dir, 'blank');
    await writeFile(blank, 'sk-abc\n\n');
    assert.equal(await readSecretFile(blank), 'sk-abc', 'no embedded \\n from a trailing blank line');

    // A value with no trailing newline is returned intact.
    const bare = join(dir, 'bare');
    await writeFile(bare, 'sk-abc');
    assert.equal(await readSecretFile(bare), 'sk-abc');
  });
});

describe('the mutation discipline', () => {
  test('without --yes it prints a plan and reports not confirmed', () => {
    const ctx = context({ confirmed: false });
    const proceed = reviewPlan(ctx, {
      action: 'Delete everything',
      target: 'ws_1',
      changes: { scope: 'all' },
    });

    assert.equal(proceed, false, 'a destructive command must not be one typo away');
    assert.ok(ctx.stdout.join('\n').includes('Nothing was changed'));
  });

  test('with --yes it proceeds', () => {
    const ctx = context({ confirmed: true });
    assert.equal(reviewPlan(ctx, { action: 'Create', target: 'x', changes: {} }), true);
  });

  test('warnings are shown before the user decides', () => {
    const ctx = context({ confirmed: false });
    reviewPlan(ctx, {
      action: 'Terminate',
      target: 'sn_1',
      changes: {},
      warnings: ['This is irreversible.'],
    });
    assert.ok(ctx.stdout.join('\n').includes('This is irreversible.'));
  });

  test('an ambiguous write is reported, never retried', () => {
    // The request may already have been applied; retrying would duplicate it.
    const ctx = context();
    const code = reportAmbiguous(
      ctx,
      new MaError({ code: 'TIMEOUT', category: 'timeout', message: 'timed out' }),
      'create a session',
    );

    assert.equal(code, 1);
    const output = ctx.stderr.join('\n');
    assert.ok(output.includes('NOT retried'));
    assert.ok(output.includes('outcome is unknown'));
  });
});

describe('error reporting', () => {
  test('maps error categories to distinct exit codes', () => {
    // So a script can branch on what went wrong.
    const cases: [MaError['category'], number][] = [
      ['validation', 2],
      ['not_found', 2],
      ['permission', 3],
      ['unauthenticated', 3],
      ['quota', 4],
      ['unavailable', 4],
      ['internal', 1],
    ];

    for (const [category, expected] of cases) {
      const code = reportError(context(), new MaError({ code: 'X', category, message: 'm' }));
      assert.equal(code, expected, `${category} should exit ${expected}`);
    }
  });

  test('lists every validation issue rather than the first', () => {
    const ctx = context();
    reportError(
      ctx,
      new MaError({
        code: 'VALIDATION_FAILED',
        category: 'validation',
        message: 'failed',
        details: {
          issues: [
            { path: 'name', message: 'is required' },
            { path: 'slug', message: 'must match' },
          ],
        },
      }),
    );

    const output = ctx.stderr.join('\n');
    assert.ok(output.includes('name'));
    assert.ok(output.includes('slug'));
  });

  test('emits structured output when --json is set', () => {
    const ctx = context({ json: true });
    reportError(ctx, new MaError({ code: 'NOT_FOUND', category: 'not_found', message: 'gone' }));
    const parsed = JSON.parse(ctx.stderr.join('\n')) as { error: { code: string } };
    assert.equal(parsed.error.code, 'NOT_FOUND');
  });
});

describe('table formatting', () => {
  test('renders rows with aligned headers', () => {
    const output = formatTable([
      { id: 'ws_1', name: 'Platform' },
      { id: 'ws_2', name: 'Team' },
    ]);
    assert.ok(output.includes('ID'));
    assert.ok(output.includes('NAME'));
    assert.ok(output.includes('Platform'));
  });

  test('says so when there is nothing to show', () => {
    assert.ok(formatTable([]).includes('no results'));
  });

  test('renders a timestamp as a date rather than a bare number', () => {
    const output = formatTable([{ createdAt: 1_700_000_000_000 }]);
    assert.ok(output.includes('2023-11-'), 'a raw epoch is unreadable');
  });
});

describe('unknown flags', () => {
  /** A stand-in command whose usage line declares the flags it takes. */
  const agentCreate: Command = {
    name: 'agent create',
    summary: 'Create an agent',
    usage: 'ma agent create --workspace ID --name NAME [--spec FILE] [--yes]',
    mutates: true,
    run: () => Promise.resolve(0),
  };

  test('accepts the flags its usage line declares, plus the global ones', () => {
    const known = knownFlags(agentCreate);
    for (const name of ['workspace', 'name', 'spec', 'yes', 'json', 'url', 'token']) {
      assert.ok(known.has(name), `--${name} should be accepted`);
    }
  });

  test('reports a flag the command does not take', () => {
    // The real failure: `agent create --prompt ... --model ...` reported
    // success while discarding both, leaving an agent with no version that
    // could never start a session. Driving the CLI by hand found it; no test
    // did, because every test passed the flags the command expected.
    const args = parseArgs([
      'agent', 'create',
      '--workspace', 'ws_1',
      '--name', 'Bot',
      '--prompt', 'be useful',
      '--model', 'claude-sonnet-5',
      '--yes',
    ]);
    assert.deepEqual(unknownFlags(agentCreate, args), ['model', 'prompt']);
  });

  test('suggests the flag a typo probably meant, including a transposition', () => {
    const workspaceCreate: Command = {
      name: 'workspace create',
      summary: 'Create a workspace',
      usage: 'ma workspace create --name NAME --slug SLUG [--yes]',
      mutates: true,
      run: () => Promise.resolve(0),
    };
    // Transposed, which plain Levenshtein scores 2 and would drop.
    assert.equal(suggestFlag('slgu', workspaceCreate), 'slug');
    assert.equal(suggestFlag('nmae', workspaceCreate), 'name');
  });

  test('stays quiet rather than guessing at something unrelated', () => {
    // A wrong suggestion is worse than none: it sends the user to a flag that
    // does not do what they wanted.
    assert.equal(suggestFlag('totally-made-up', agentCreate), undefined);
    assert.equal(suggestFlag('model', agentCreate), undefined);
  });

  test('a usage string with alternatives still declares its flags', () => {
    // `session list` advertises `(--workspace ID | --agent ID)` rather than two
    // optional flags, because the API scopes a list by workspace to authorize
    // it and an unscoped call is a validation error. The derivation reads flags
    // out of the usage line, so the alternation must not hide them.
    const commands = buildCommands({ client: {} as never });
    const sessionList = commands.find((command) => command.name === 'session list');
    assert.ok(sessionList, 'session list must exist');

    const known = knownFlags(sessionList);
    assert.ok(known.has('workspace'), '--workspace must be accepted');
    assert.ok(known.has('agent'), '--agent must be accepted');
    assert.ok(known.has('statuses'));
  });

  test('every real command accepts the flags its own usage advertises', () => {
    // Guards the derivation itself: usage strings are the source of truth for
    // what is accepted, so a malformed one silently narrows a command.
    const commands = buildCommands({ client: {} as never });
    for (const command of commands) {
      const declared = [...command.usage.matchAll(/--([a-z0-9][a-z0-9-]*)/gi)].map((m) => m[1]!);
      const known = knownFlags(command);
      for (const name of declared) {
        assert.ok(known.has(name), `${command.name} advertises --${name} but would reject it`);
      }
    }
  });

  test('every flag a command READS appears in its usage (no unreachable flags)', async () => {
    // The reverse of the test above, and the one that was missing: knownFlags is
    // derived from usage, so the usage→known direction is tautological. A flag a
    // command's body reads but its usage omits is silently UNREACHABLE — the
    // strict unknown-flag gate rejects it with exit 2 before the command runs.
    // (This is how `credential create --owner-type` was rejected, forcing every
    // CLI credential to workspace scope.) The run bodies are closures, so scan
    // the source: split into per-command segments and check each segment's flag
    // reads against its own usage string.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const src = await readFile(
      fileURLToPath(new URL('../src/commands.ts', import.meta.url)),
      'utf8',
    );
    const globals = new Set(['url', 'token', 'json', 'yes', 'help', 'version']);

    // Segment boundaries: each command literal starts at `name: '...'`.
    const nameRe = /name: '([^']+)'/g;
    const bounds: { name: string; index: number }[] = [];
    for (const m of src.matchAll(nameRe)) bounds.push({ name: m[1]!, index: m.index! });

    const offenders: string[] = [];
    for (let i = 0; i < bounds.length; i++) {
      const segment = src.slice(bounds[i]!.index, bounds[i + 1]?.index ?? src.length);
      const usageMatch = segment.match(/usage: '([^']+)'/);
      if (!usageMatch) continue; // a group header, not a runnable command
      const usageFlags = new Set(
        [...usageMatch[1]!.matchAll(/--([a-z0-9][a-z0-9-]*)/gi)].map((m) => m[1]!),
      );
      // Every way a flag is read by name.
      const reads = new Set<string>();
      for (const m of segment.matchAll(/(?:requireFlag|flag)\(context, '([a-z0-9-]+)'\)/g)) {
        reads.add(m[1]!);
      }
      for (const m of segment.matchAll(/flags\.(?:get|has)\('([a-z0-9-]+)'\)/g)) {
        reads.add(m[1]!);
      }
      for (const name of reads) {
        if (globals.has(name) || usageFlags.has(name)) continue;
        offenders.push(`${bounds[i]!.name} reads --${name} but its usage omits it`);
      }
    }

    assert.deepEqual(offenders, [], `unreachable flags:\n${offenders.join('\n')}`);
  });

  test('exits non-zero and prints usage rather than running the command', async () => {
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const code = await main([
        'workspace', 'create',
        '--name', 'X',
        '--slgu', 'y',
        '--yes',
        '--token', 'test-token',
      ]);
      assert.equal(code, 2, 'a typo must not be a successful run');
    } finally {
      process.stderr.write = write;
    }

    const output = errors.join('');
    assert.match(output, /Unknown flag --slgu/);
    assert.match(output, /Did you mean --slug\?/);
    assert.match(output, /Usage: ma workspace create/);
  });
});

describe('connector, dataset and audit commands', () => {
  /** Run a named command with the given flags against a recording fake client. */
  async function run(
    name: string,
    flags: Record<string, string | boolean>,
    client: Record<string, unknown>,
    opts: { confirmed?: boolean; json?: boolean } = {},
  ): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
    const commands = buildCommands({ client: client as never });
    const command = commands.find((c) => c.name === name);
    assert.ok(command, `command ${name} must exist`);
    const flagMap = new Map<string, string | boolean>(Object.entries(flags));
    const ctx = context({
      args: { positional: name.split(' '), flags: flagMap },
      confirmed: opts.confirmed ?? false,
      json: opts.json ?? false,
    });
    const code = await command.run(ctx);
    return { code, stdout: ctx.stdout, stderr: ctx.stderr };
  }

  test('every new command group is registered', () => {
    const commands = buildCommands({ client: {} as never });
    const names = new Set(commands.map((c) => c.name));
    for (const expected of [
      'connector list', 'connector get', 'connector create', 'connector update',
      'connector activate', 'connector status', 'connector run', 'connector next-fire',
      'connector receipts', 'receipt retry',
      'dataset list', 'dataset create', 'dataset add-document', 'dataset documents', 'dataset bind',
      'audit list',
    ]) {
      assert.ok(names.has(expected), `${expected} must be registered`);
    }
  });

  test('connector list calls the SDK and tabulates the result', async () => {
    let calledWith: unknown;
    const client = {
      listConnectors: (workspaceId: string, filter: unknown) => {
        calledWith = { workspaceId, filter };
        return Promise.resolve({
          items: [
            { id: 'cn_1', type: 'chat', name: 'bot', status: 'active', externalKey: 'k', agentId: 'ag_1' },
          ],
          nextCursor: undefined,
        });
      },
    };
    const { code, stdout } = await run('connector list', { workspace: 'ws_1', type: 'chat' }, client);
    assert.equal(code, 0);
    assert.deepEqual(calledWith, { workspaceId: 'ws_1', filter: { type: 'chat' } });
    assert.ok(stdout.join('\n').includes('cn_1'));
  });

  test('connector create is refused without --yes and applied with it', async () => {
    let created = false;
    const client = {
      createConnector: () => {
        created = true;
        return Promise.resolve({ id: 'cn_new', type: 'webhook', name: 'n', status: 'draft' });
      },
    };
    const flags = { workspace: 'ws_1', type: 'webhook', name: 'n', 'external-key': 'k' };

    const dry = await run('connector create', flags, client, { confirmed: false });
    assert.equal(created, false, 'a mutation must not run without confirmation');
    assert.ok(dry.stdout.join('\n').includes('Nothing was changed'));

    const wet = await run('connector create', flags, client, { confirmed: true });
    assert.equal(created, true);
    assert.equal(wet.code, 0);
  });

  test('connector activate warns and, once confirmed, activates', async () => {
    let activated: string | undefined;
    const client = {
      activateConnector: (id: string) => {
        activated = id;
        return Promise.resolve({ id, type: 'chat', name: 'b', status: 'active' });
      },
    };
    const dry = await run('connector activate', { connector: 'cn_1' }, client, { confirmed: false });
    assert.equal(activated, undefined);
    assert.ok(dry.stdout.join('\n').toLowerCase().includes('network'));

    await run('connector activate', { connector: 'cn_1' }, client, { confirmed: true });
    assert.equal(activated, 'cn_1');
  });

  test('connector receipts passes a comma-split status filter', async () => {
    let filter: unknown;
    const client = {
      listReceipts: (_id: string, f: unknown) => {
        filter = f;
        return Promise.resolve({ items: [], nextCursor: undefined });
      },
    };
    await run('connector receipts', { connector: 'cn_1', statuses: 'failed,zombie' }, client);
    assert.deepEqual(filter, { statuses: ['failed', 'zombie'] });
  });

  test('connector run fires a schedule only after confirmation', async () => {
    let ran = false;
    const client = {
      runConnector: () => {
        ran = true;
        return Promise.resolve({ receiptId: 'rc_1', created: true });
      },
    };
    await run('connector run', { connector: 'cn_1' }, client, { confirmed: false });
    assert.equal(ran, false);
    await run('connector run', { connector: 'cn_1' }, client, { confirmed: true });
    assert.equal(ran, true);
  });

  test('dataset add-document reads content from a file and warns about trust', async () => {
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'ma-cli-'));
    const path = join(dir, 'doc.txt');
    await writeFile(path, 'the knowledge', 'utf8');

    let added: unknown;
    const client = {
      addDocument: (datasetId: string, input: unknown) => {
        added = { datasetId, input };
        return Promise.resolve({ id: 'doc_1', name: 'D', status: 'pending', source: 'inline', chunkCount: 0 });
      },
    };
    const flags = { dataset: 'ds_1', name: 'D', 'content-file': path };

    const dry = await run('dataset add-document', flags, client, { confirmed: false });
    assert.equal(added, undefined);
    assert.ok(dry.stdout.join('\n').toLowerCase().includes('trust'));

    await run('dataset add-document', flags, client, { confirmed: true });
    assert.deepEqual(added, {
      datasetId: 'ds_1',
      input: { name: 'D', content: 'the knowledge', source: 'inline' },
    });
  });

  test('dataset bind rejects an empty list and binds a real one', async () => {
    let bound: unknown;
    const client = {
      bindDatasets: (agentId: string, datasetIds: string[]) => {
        bound = { agentId, datasetIds };
        return Promise.resolve({ agentId, datasetIds });
      },
    };
    const empty = await run('dataset bind', { agent: 'ag_1', datasets: ',' }, client, { confirmed: true });
    assert.equal(empty.code, 2, 'a --datasets with no real ids is a usage error');
    assert.equal(bound, undefined);

    await run('dataset bind', { agent: 'ag_1', datasets: 'ds_1,ds_2' }, client, { confirmed: true });
    assert.deepEqual(bound, { agentId: 'ag_1', datasetIds: ['ds_1', 'ds_2'] });
  });

  test('audit list scopes by workspace and action', async () => {
    let filter: unknown;
    const client = {
      listAudit: (workspaceId: string, f: unknown) => {
        filter = { workspaceId, f };
        return Promise.resolve({
          items: [
            { at: 1_700_000_000_000, action: 'session.create', outcome: 'allowed', principalId: 'pr_1', resourceId: 'se_1' },
          ],
          nextCursor: undefined,
        });
      },
    };
    const { stdout } = await run('audit list', { workspace: 'ws_1', action: 'session.create' }, client);
    assert.deepEqual(filter, { workspaceId: 'ws_1', f: { action: 'session.create' } });
    assert.ok(stdout.join('\n').includes('session.create'));
  });
});

describe('terminal output', () => {
  // A provider's model names and an agent's text are third-party bytes. Written
  // raw to a terminal, an escape sequence can retitle the window, recolour the
  // output, plant a hidden hyperlink or (on some terminals) write the clipboard.
  const HOSTILE = '\u001b]0;PWNED\u0007\u001b[31mRED\u001b[0m \u001b]8;;https://attacker.example\u0007link\u009b2J';
  const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

  async function run(name: string, flags: Record<string, string | boolean>, client: Record<string, unknown>) {
    const command = buildCommands({ client: client as never }).find((c) => c.name === name);
    assert.ok(command, `command ${name} must exist`);
    const ctx = context({ args: { positional: name.split(' '), flags: new Map(Object.entries(flags)) } });
    const code = await command.run(ctx);
    return { code, stdout: ctx.stdout.join('\n'), stderr: ctx.stderr.join('\n') };
  }

  test('ma model free prints a provider-controlled name as visible text, not as terminal commands', async () => {
    const { code, stdout } = await run('model free', { all: true }, {
      listFreeModels: () => Promise.resolve({ models: [{ id: `evil/${HOSTILE}:free`, name: HOSTILE, tools: false, contextLength: 1 }] }),
    });
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, RAW_CONTROL);
    assert.match(stdout, /\\x1b\]0;PWNED/, 'what was there is still shown, escaped');
  });

  test('ma session watch escapes agent text the same way', async () => {
    const { stdout } = await run('session watch', { session: 'sn_1' }, {
      streamEvents: async function* () {
        yield { seq: 1, type: 'message.completed', payload: { text: HOSTILE } };
      },
    });
    assert.doesNotMatch(stdout, RAW_CONTROL);
  });

  test('an error message from upstream is escaped before it reaches the terminal', () => {
    const ctx = context();
    reportError(ctx, new MaError({ code: 'UPSTREAM', category: 'unavailable', message: `OpenRouter error 502: ${HOSTILE}` }));
    assert.doesNotMatch(ctx.stderr.join('\n'), RAW_CONTROL);
  });

  test('--json output stays exact, for scripts', async () => {
    const command = buildCommands({
      client: { listFreeModels: () => Promise.resolve({ models: [{ id: 'a/b:free', name: HOSTILE, tools: true, contextLength: 1 }] }) } as never,
    }).find((c) => c.name === 'model free');
    const ctx = context({ json: true, args: { positional: ['model', 'free'], flags: new Map() } });
    await command!.run(ctx);
    assert.equal((JSON.parse(ctx.stdout.join('\n')) as { models: { name: string }[] }).models[0]?.name, HOSTILE);
  });
});

describe('model free-add', () => {
  test('the plan says an existing registration is refreshed, and nothing is sent without --yes', async () => {
    let called = false;
    const command = buildCommands({
      client: { registerFreeModel: () => { called = true; return Promise.resolve({ model: { id: 'x' } }); } } as never,
    }).find((c) => c.name === 'model free-add');
    const ctx = context({ args: { positional: ['model', 'free-add'], flags: new Map([['model', 'a/b:free']]) } });
    assert.equal(await command!.run(ctx), 0);
    assert.equal(called, false);
    const plan = ctx.stdout.join('\n');
    assert.match(plan, /refresh if already registered/);
    assert.match(plan, /enabled and which workspaces may use it are kept/);
  });
});

describe('the API token on the command line', () => {
  // stderr only: the test runner reports results over this process's stdout.
  async function capture(run: () => Promise<number>): Promise<{ code: number; stderr: string }> {
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await run();
      return { code, stderr: errors.join('') };
    } finally {
      process.stderr.write = write;
    }
  }

  test('--token still works but warns that argv is readable by other processes', async () => {
    const { stderr } = await capture(() => main(['no-such-command', '--token', 'argv-token']));
    assert.match(stderr, /warning: --token puts the API token in argv/);
    assert.match(stderr, /--token-file/);
  });

  test('--token-file sends the file’s token, without its trailing newline, and prints no warning', async () => {
    const { createServer } = await import('node:http');
    const { mkdtemp, writeFile: write } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', version: 'test' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const file = join(await mkdtemp(join(tmpdir(), 'ma-cli-')), 'token');
    await write(file, 'file-token\r\n');
    try {
      const { code, stderr } = await capture(() =>
        main(['health', '--token-file', file, '--url', `http://127.0.0.1:${port}`]),
      );
      assert.equal(code, 0, stderr);
      assert.equal(authorization, 'Bearer file-token');
      assert.doesNotMatch(stderr, /warning/);
    } finally {
      server.close();
    }
  });

  test('both --token and --token-file is refused rather than silently picking one', async () => {
    const { code, stderr } = await capture(() => main(['health', '--token', 'a', '--token-file', '/nonexistent']));
    assert.equal(code, 2);
    assert.match(stderr, /either --token or --token-file, not both/);
  });

  test('an unreadable --token-file names the file and what it must hold', async () => {
    const { code, stderr } = await capture(() => main(['health', '--token-file', '/nonexistent/ma-token']));
    assert.equal(code, 2);
    assert.match(stderr, /\/nonexistent\/ma-token/);
    assert.match(stderr, /non-empty file that holds only the token/);
  });
});
