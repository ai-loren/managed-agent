/**
 * `@ma/runtime` — the agent harness.
 */

export {
  collect,
  type ModelChunk,
  type ModelClient,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type StopReason,
  type ToolSchema,
} from './model.ts';

export {
  PermissionEngine,
  ToolRegistry,
  type PermissionDecision,
  type PermissionOutcome,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './tools.ts';

export {
  ContextWindow,
  estimateContextTokens,
  estimateMessageTokens,
  estimateTokens,
  type CompactionResult,
  type Summarizer,
} from './context.ts';

export {
  AgentHarness,
  type HarnessEvents,
  type HarnessOptions,
  type TurnResult,
} from './harness.ts';

export {
  builtinTools,
  createShellTool,
  listDirectoryTool,
  readFileTool,
  searchTool,
  writeFileTool,
  type ShellToolOptions,
} from './builtin-tools.ts';
