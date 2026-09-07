/**
 * Assembling a session's tools.
 *
 * The harness receives a `ToolRegistry`; something has to decide what goes in
 * it. That decision is per-session rather than global, because two sessions of
 * different agents legitimately see different tools — different datasets,
 * different sub-agents, different policy.
 *
 * This is the seam where the platform's capabilities become one agent's
 * capabilities, so it is deliberately explicit rather than a registry that
 * accumulates whatever imported itself.
 */

import { type Clock, type Logger } from '@ma/core';
import type { AgentVersion, Session } from '@ma/contracts';
import type { RetrievalService } from '@ma/engine';
import {
  SubAgentRunner,
  ToolRegistry,
  builtinTools,
  createDelegateTool,
  createRetrievalTool,
  type HarnessEvents,
  type ModelClient,
} from '@ma/runtime';

export interface ToolsetOptions {
  session: Session;
  /** The session's *pinned* version — never the agent's latest. */
  version: AgentVersion;
  model: ModelClient;
  events: HarnessEvents;
  clock: Clock;
  workDir: string;
  retrieval?: RetrievalService;
  logger?: Logger;
}

/**
 * Build the tools one session may use.
 *
 * Everything here is derived from the pinned version, so a session's
 * capabilities are as frozen as the rest of its configuration. Adding a dataset
 * to an agent does not widen a session already running.
 */
export function buildToolset(options: ToolsetOptions): ToolRegistry {
  const { version } = options;
  const registry = new ToolRegistry();

  // The built-ins are the tools with direct filesystem and process access, so
  // the set stays small and the permission engine does the narrowing.
  registry.registerAll(builtinTools({ clock: options.clock }));

  // Retrieval appears only when the version actually binds datasets. An agent
  // with no knowledge base should not be offered a tool that can only ever
  // answer "nothing is attached".
  if (options.retrieval && version.datasetIds.length > 0) {
    registry.register(
      createRetrievalTool({
        retrieval: options.retrieval,
        datasetIds: version.datasetIds,
      }),
    );
  }

  // Same reasoning for delegation: no sub-agents, no tool.
  if (version.subAgents.length > 0) {
    const runner = new SubAgentRunner({
      sessionId: options.session.id,
      workspaceId: options.session.workspaceId,
      parentVersion: version,
      model: options.model,
      // The child's registry is derived from this one, so it can never contain
      // a tool the parent does not already have.
      tools: registry,
      events: options.events,
      clock: options.clock,
      workDir: options.workDir,
      ...(options.logger ? { logger: options.logger } : {}),
    });

    registry.register(createDelegateTool({ runner, subAgents: version.subAgents }));
  }

  return registry;
}
