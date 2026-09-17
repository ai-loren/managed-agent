/**
 * `@ma/cli` — the `ma` command line.
 */

export {
  formatDetail,
  formatTable,
  knownFlags,
  parseArgs,
  reportAmbiguous,
  reportError,
  reviewPlan,
  suggestFlag,
  unknownFlags,
  type Command,
  type CommandContext,
  type ParsedArgs,
  type Plan,
} from './framework.ts';

export { buildCommands, readSecretFile, type CommandDeps } from './commands.ts';
export { main } from './main.ts';
