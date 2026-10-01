#!/usr/bin/env node
/**
 * `ma` — the Managed-Agent command line.
 *
 * Configuration comes from the environment (`MA_URL`, `MA_TOKEN`) or from
 * flags. Prefer `MA_TOKEN` or `--token-file`: argv is visible to every process
 * on the host and lands in shell history, so `--token` still works but warns.
 */

import { ManagedAgentClient } from '@ma/sdk';

import { buildCommands, readSecretFile } from './commands.ts';
import {
  parseArgs,
  reportError,
  suggestFlag,
  unknownFlags,
  type Command,
  type CommandContext,
} from './framework.ts';

const VERSION = '0.1.0';

function usage(commands: readonly Command[]): string {
  const width = Math.max(...commands.map((command) => command.name.length));
  const lines = commands
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`);

  return [
    'ma — manage hosted agents',
    '',
    'Usage: ma <command> [flags]',
    '',
    'Commands:',
    ...lines,
    '',
    'Global flags:',
    '  --url URL        API base URL (default: $MA_URL or http://127.0.0.1:8080)',
    '  --token-file F   Read the API token from file F (default: $MA_TOKEN)',
    '  --token TOKEN    API token on the command line (visible to other processes; avoid)',
    '  --json           Emit JSON instead of a table',
    '  --yes            Apply a mutation; without it, commands only print a plan',
    '  --version        Print the version',
    '  --help           Print this help',
    '',
    'Mutations print a plan and change nothing unless --yes is given.',
  ].join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  const out = (text: string): void => void process.stdout.write(`${text}\n`);
  const err = (text: string): void => void process.stderr.write(`${text}\n`);

  const context: CommandContext = {
    args,
    json: args.flags.get('json') === true,
    confirmed: args.flags.get('yes') === true,
    out,
    err,
  };

  if (args.flags.get('version') === true) {
    out(VERSION);
    return 0;
  }

  const baseUrl =
    (typeof args.flags.get('url') === 'string' ? String(args.flags.get('url')) : undefined) ??
    process.env.MA_URL ??
    'http://127.0.0.1:8080';
  const tokenFlag = typeof args.flags.get('token') === 'string' ? String(args.flags.get('token')) : undefined;
  const tokenFile = typeof args.flags.get('token-file') === 'string' ? String(args.flags.get('token-file')) : undefined;
  if (tokenFlag !== undefined && tokenFile !== undefined) {
    err('Pass either --token or --token-file, not both.');
    return 2;
  }
  if (tokenFlag !== undefined) {
    err(
      'warning: --token puts the API token in argv, where every process on this host can read it ' +
        'and your shell history keeps it. Use MA_TOKEN or --token-file instead.',
    );
  }
  let token = tokenFlag ?? process.env.MA_TOKEN ?? '';
  if (tokenFile !== undefined) {
    try {
      token = await readSecretFile(tokenFile);
    } catch (error) {
      err(
        `Could not read the API token from --token-file ${tokenFile}: ${error instanceof Error ? error.message : String(error)}. ` +
          'Point it at a readable, non-empty file that holds only the token.',
      );
      return 2;
    }
  }

  const commands = buildCommands({ client: new ManagedAgentClient({ baseUrl, token }) });

  if (args.positional.length === 0 || args.flags.get('help') === true) {
    out(usage(commands));
    return args.positional.length === 0 ? 1 : 0;
  }

  // Command names have several words (`agent version create`), so match the
  // longest name that prefixes the positional arguments.
  const joined = args.positional.join(' ');
  const command = commands
    .filter((candidate) => joined === candidate.name || joined.startsWith(`${candidate.name} `))
    .sort((a, b) => b.name.length - a.name.length)[0];

  if (!command) {
    err(`Unknown command: ${joined}`);
    err('');
    err(usage(commands));
    return 2;
  }

  // Before the token check, so a typo is reported even when the shell has no
  // credentials configured — the two failures are unrelated and the flag one is
  // more likely to be what the user actually got wrong.
  const unknown = unknownFlags(command, args);
  if (unknown.length > 0) {
    for (const name of unknown) {
      const suggestion = suggestFlag(name, command);
      err(`Unknown flag --${name}${suggestion ? `. Did you mean --${suggestion}?` : ''}`);
    }
    err('');
    err(`Usage: ${command.usage}`);
    return 2;
  }

  if (!token) {
    err('No API token. Set MA_TOKEN or pass --token-file PATH.');
    return 3;
  }

  try {
    return await command.run(context);
  } catch (error) {
    return reportError(context, error);
  }
}

// Only run when invoked directly, so the module stays importable by tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
