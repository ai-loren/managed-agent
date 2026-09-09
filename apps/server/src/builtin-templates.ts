/**
 * The platform's built-in agent templates.
 *
 * A small, curated catalogue so a new workspace has something to instantiate on
 * day one rather than a blank spec. Each is an ordinary template — a spec with
 * `{{variable}}` placeholders plus the variables they draw from — seeded as a
 * built-in (read-only, shared across every workspace) on boot.
 *
 * Deliberately conservative: every spec uses a `{{model}}` variable rather than
 * a hard-coded model id, because which models a deployment catalogues is a
 * deployment decision. The defaults name nothing that must exist.
 */

import type { CreateTemplateInput } from '@ma/engine';

/** A `model` variable every template shares: which catalogued model to run. */
const modelVariable = {
  key: 'model',
  label: 'Model',
  description: 'The catalogued model this agent runs on.',
  type: 'string' as const,
  required: true,
  options: [] as string[],
};

export const BUILTIN_TEMPLATES: readonly CreateTemplateInput[] = [
  {
    name: 'General assistant',
    category: 'general',
    description: 'A helpful, general-purpose assistant with a configurable persona.',
    spec: {
      systemPrompt:
        'You are {{persona}}, a helpful assistant. Answer clearly and concisely, and say ' +
        'when you are unsure rather than guessing.',
      model: { modelId: '{{model}}' },
    },
    variables: [
      modelVariable,
      {
        key: 'persona',
        label: 'Persona',
        description: 'How the assistant introduces itself.',
        type: 'string',
        required: false,
        options: [],
        default: 'a knowledgeable assistant',
      },
    ],
  },
  {
    name: 'Coding agent',
    category: 'coding',
    description: 'An agent that reads a codebase and proposes changes, with shell and file tools.',
    spec: {
      systemPrompt:
        'You are a senior {{language}} engineer. Read before you write, match the surrounding ' +
        'style, and explain any change you propose. Never run a destructive command without saying so first.',
      model: { modelId: '{{model}}' },
      tools: { shell: { enabled: true }, filesystem: { enabled: true } },
      maxTurnsPerSession: '{{maxTurns}}',
    },
    variables: [
      modelVariable,
      {
        key: 'language',
        label: 'Primary language',
        description: 'The main language of the codebase, for the persona.',
        type: 'string',
        required: false,
        options: [],
        default: 'software',
      },
      {
        key: 'maxTurns',
        label: 'Max turns per session',
        description: 'How many turns a single session may run before stopping.',
        type: 'number',
        required: false,
        options: [],
        default: 200,
      },
    ],
  },
  {
    name: 'Research assistant',
    category: 'research',
    description: 'Answers questions from an attached knowledge base using retrieval.',
    spec: {
      systemPrompt:
        'You answer questions using the attached knowledge base. Cite the source of each claim, ' +
        'and if the answer is not in the material, say so rather than inventing one. Keep a {{tone}} tone.',
      model: { modelId: '{{model}}' },
      tools: { retrieval: { enabled: true } },
    },
    variables: [
      modelVariable,
      {
        key: 'tone',
        label: 'Tone',
        description: 'The register of the assistant’s answers.',
        type: 'enum',
        required: false,
        options: ['formal', 'neutral', 'friendly'],
        default: 'neutral',
      },
    ],
  },
  {
    name: 'Scheduled reporter',
    category: 'automation',
    description: 'A locked-down agent for scheduled jobs: no network, no shell, one clear task.',
    spec: {
      systemPrompt:
        'You run on a schedule to produce: {{task}}. Do exactly this task and nothing else. ' +
        'Produce your output as a single artifact.',
      model: { modelId: '{{model}}' },
      // The safe posture for unattended runs: no egress, no shell.
      sandbox: { network: { egress: 'deny', allowedHosts: [] } },
      tools: { shell: { enabled: false }, filesystem: { enabled: true } },
    },
    variables: [
      modelVariable,
      {
        key: 'task',
        label: 'Task description',
        description: 'What the scheduled run should produce each time.',
        type: 'string',
        required: true,
        options: [],
      },
    ],
  },
];
