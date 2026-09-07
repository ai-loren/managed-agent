#!/usr/bin/env node
/**
 * `ma` — the Managed-Agent command line.
 *
 * Configuration comes from the environment (`MA_URL`, `MA_TOKEN`) or from
 * flags. The token is never accepted as a positional argument: argv is visible
 * to every process on the host.
 */

import { ManagedAgentClient } from '@ma/sdk';

import { buildCommands } from './commands.ts';
import { parseArgs, reportError, type Command, type CommandContext } from './framework.ts';

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
    '  --token TOKEN    API token (default: $MA_TOKEN)',
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
  const token =
    (typeof args.flags.get('token') === 'string' ? String(args.flags.get('token')) : undefined) ??
    process.env.MA_TOKEN ??
    '';

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

  if (!token) {
    err('No API token. Set MA_TOKEN or pass --token.');
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
