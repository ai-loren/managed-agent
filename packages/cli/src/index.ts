/**
 * `@ma/cli` — the `ma` command line.
 */

export {
  formatDetail,
  formatTable,
  parseArgs,
  reportAmbiguous,
  reportError,
  reviewPlan,
  type Command,
  type CommandContext,
  type ParsedArgs,
  type Plan,
} from './framework.ts';

export { buildCommands, type CommandDeps } from './commands.ts';
export { main } from './main.ts';
