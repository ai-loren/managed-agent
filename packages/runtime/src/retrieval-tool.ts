/**
 * The dataset retrieval tool.
 *
 * Exposed as a tool rather than injected into the prompt, so the agent decides
 * when its knowledge base is relevant. Stuffing every session's context with
 * documents it did not need is how a knowledge base makes an agent worse.
 *
 * Results carry citations. An agent that can attribute a claim to a named
 * document is one an operator can check, and an agent that cannot is one whose
 * confident answers are indistinguishable from its invented ones.
 */

import { validationError } from '@ma/core';

import type { Tool, ToolContext, ToolResult } from './tools.ts';

/** What the tool needs from the engine, kept narrow so it stays testable. */
export interface DatasetSearch {
  search(
    datasetIds: readonly string[],
    query: string,
    limit?: number,
  ): Promise<{ source: string; index: number; text: string; score: number }[]>;
  format(
    results: readonly { source: string; index: number; text: string; score: number }[],
  ): string;
}

/**
 * Format retrieval results for a model, with citations so it can attribute
 * claims. Shared so the sandbox side formats identically to the control plane's
 * own `RetrievalService.format`.
 */
export function formatRetrievalResults(
  results: readonly { source: string; index: number; text: string; score: number }[],
): string {
  if (results.length === 0) return 'No relevant documents were found.';
  return results
    .map(
      (result, position) =>
        `[${position + 1}] ${result.source} (chunk ${result.index}, score ${result.score.toFixed(2)})\n${result.text}`,
    )
    .join('\n\n');
}

export interface RetrievalToolOptions {
  retrieval: DatasetSearch;
  /**
   * Datasets this session may search — the ids on its *pinned* version, so
   * widening an agent's datasets never widens a session already running.
   */
  datasetIds: readonly string[];
  maxResults?: number;
}

export function createRetrievalTool(options: RetrievalToolOptions): Tool {
  const maxResults = options.maxResults ?? 8;

  return {
    name: 'search_knowledge',
    description:
      'Search the knowledge bases attached to this agent. Use it for facts that live in ' +
      'documentation, runbooks or reference material rather than guessing. Results are cited ' +
      'by source so you can attribute what you use.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to look for. Specific terms retrieve better than whole sentences.',
        },
        limit: {
          type: 'integer',
          description: `Results to return (1-${maxResults})`,
          default: 5,
        },
      },
      required: ['query'],
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      void context;

      const query = String(args.query ?? '').trim();
      if (query.length === 0) throw validationError('A query is required');

      if (options.datasetIds.length === 0) {
        // Said plainly, so the agent stops trying rather than rephrasing.
        return { output: 'This agent has no knowledge bases attached.' };
      }

      const limit = Math.min(Math.max(Number(args.limit ?? 5), 1), maxResults);
      const results = await options.retrieval.search(options.datasetIds, query, limit);

      if (results.length === 0) {
        // Distinguishing "nothing matched" from "nothing is attached" matters:
        // one means rephrase, the other means stop.
        return { output: `No documents matched "${query}".` };
      }

      return { output: options.retrieval.format(results) };
    },
  };
}
