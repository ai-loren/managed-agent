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
  estimateToolTokens,
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
  createSearchTool,
  createShellTool,
  listDirectoryTool,
  readFileTool,
  searchTool,
  writeFileTool,
  type SearchToolOptions,
  type ShellToolOptions,
} from './builtin-tools.ts';

export {
  createRetrievalTool,
  formatRetrievalResults,
  type DatasetSearch,
  type RetrievalToolOptions,
} from './retrieval-tool.ts';
export {
  parseSkillManifest,
  parseSkillTools,
  formatSkillInstructions,
  type SkillManifest,
  type SkillToolSpec,
  type ParsedSkill,
} from './skills.ts';
export { createSkillTools, skillToolName } from './skill-tool.ts';
export { parsePluginManifest, type PluginManifest } from './plugins.ts';
export {
  sniffArchive,
  unpackTar,
  extractArchive,
  skillInstallDir,
  type ArchiveKind,
  type ArchiveEntry,
} from './archive.ts';
export {
  McpStdioConnection,
  McpHttpConnection,
  McpSupervisor,
  createMcpTools,
  mcpToolName,
  resolveCredentialRefs,
  type McpConnection,
  type McpServerConfig,
} from './mcp.ts';

export {
  MAX_DELEGATION_DEPTH,
  SubAgentRunner,
  createDelegateTool,
  type SubAgentResult,
  type SubAgentRunnerOptions,
} from './subagent.ts';
