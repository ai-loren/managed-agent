/**
 * Agent templates: reusable, parameterised agent blueprints.
 *
 * A template is a convenience, not a new source of authority. It carries a
 * `spec` — the same shape `AgentService.create` accepts — with `{{variable}}`
 * placeholders, plus the typed variables those placeholders draw from.
 * Instantiating one substitutes the variables and hands the result to the
 * ordinary agent-create path, which validates it as an `AgentVersion`. So the
 * immutable version contract is never touched: whatever a template produces is
 * validated exactly as a hand-written spec would be.
 *
 * Two trust boundaries shape this file:
 *
 *  1. **Built-ins are read-only.** A template the platform ships (`builtin`,
 *     `workspaceId` absent) is visible to every workspace and cannot be edited
 *     or deleted through the API — otherwise a re-seed on the next boot would be
 *     silently shadowed by an edited copy, or one workspace could change what
 *     every other sees.
 *  2. **Instantiation is agent creation.** It runs the same authorization and
 *     quota admission as `AgentService.create`, because that is exactly what it
 *     does; a template is not a way around either.
 */

import { conflict, newId, notFound, validationError } from '@ma/core';
import {
  agentTemplateSchema,
  parseOrThrow,
  type Agent,
  type AgentTemplate,
  type TemplateVariable,
} from '@ma/contracts';
import type { AgentTemplateFilter, Page } from '@ma/store';

import { AgentService, BaseService, type ServiceDeps } from './agents.ts';
import type { AuthContext } from './authz.ts';

export interface CreateTemplateInput {
  name: string;
  description?: string;
  category?: string;
  spec: Record<string, unknown>;
  variables?: TemplateVariable[];
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  category?: string;
  spec?: Record<string, unknown>;
  variables?: TemplateVariable[];
}

export interface InstantiateInput {
  /** The workspace the new agent belongs to. */
  workspaceId: string;
  /** Overrides the template name for the created agent. */
  agentName?: string;
  description?: string;
  labels?: string[];
  /** Values for the template's variables, by key. */
  variables?: Record<string, unknown>;
}

export class TemplateService extends BaseService {
  readonly #agents: AgentService;

  constructor(deps: ServiceDeps) {
    super(deps);
    // Instantiation is agent creation, so it goes through the real service —
    // same validation, same quota, same audit — rather than a shortcut.
    this.#agents = new AgentService(deps);
  }

  /**
   * Author a workspace template.
   *
   * Never a built-in: those are seeded by the platform, not created through the
   * API, so `builtin` is hard-coded false here the way `origin` is hard-coded
   * on an agent memory.
   */
  async create(
    context: AuthContext,
    workspaceId: string,
    input: CreateTemplateInput,
  ): Promise<AgentTemplate> {
    const workspace = await this.requireWorkspace(workspaceId);
    this.authorizer.require(context, workspace, 'template.create');

    const now = this.clock.now();
    const template = parseOrThrow(agentTemplateSchema, {
      id: newId('agentTemplate', now),
      workspaceId: workspace.id,
      name: input.name,
      description: input.description ?? '',
      category: input.category ?? 'general',
      builtin: false,
      spec: input.spec,
      variables: input.variables ?? [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: context.principal.id,
    });
    assertVariablesConsistent(template.variables);

    const created = await this.store.agentTemplates.create(template);
    await this.audit(context, {
      workspaceId: workspace.id,
      action: 'template.create',
      resourceKind: 'agentTemplate',
      resourceId: created.id,
      outcome: 'allowed',
    });
    return created;
  }

  async get(context: AuthContext, templateId: string): Promise<AgentTemplate> {
    const template = await this.#require(templateId);
    // A built-in is readable by anyone in any workspace; a workspace template
    // needs read on its own workspace.
    if (template.workspaceId) {
      const workspace = await this.requireWorkspace(template.workspaceId);
      await this.requireOnResource(context, workspace, 'template.read', {
        kind: 'template',
        id: templateId,
      });
    }
    return template;
  }

  /**
   * The catalogue a workspace sees: its own templates plus the platform's
   * built-ins. Requires read on the workspace, because the workspace-owned
   * entries are part of the answer.
   */
  async list(
    context: AuthContext,
    workspaceId: string,
    filter: { category?: string; limit?: number; cursor?: string } = {},
  ): Promise<Page<AgentTemplate>> {
    const workspace = await this.requireWorkspace(workspaceId);
    this.authorizer.require(context, workspace, 'template.read');
    const query: AgentTemplateFilter = {
      workspaceId: workspace.id,
      includeBuiltins: true,
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.limit === undefined ? {} : { limit: filter.limit }),
      ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
    };
    return this.store.agentTemplates.list(query);
  }

  async update(
    context: AuthContext,
    templateId: string,
    patch: UpdateTemplateInput,
  ): Promise<AgentTemplate> {
    const template = await this.#requireEditable(context, templateId, 'template.update');

    if (patch.variables) assertVariablesConsistent(patch.variables);

    const updated = await this.store.agentTemplates.update(templateId, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.category === undefined ? {} : { category: patch.category }),
      ...(patch.spec === undefined ? {} : { spec: patch.spec }),
      ...(patch.variables === undefined ? {} : { variables: patch.variables }),
      updatedAt: this.clock.now(),
    });

    await this.audit(context, {
      workspaceId: template.workspaceId ?? '',
      action: 'template.update',
      resourceKind: 'agentTemplate',
      resourceId: templateId,
      outcome: 'allowed',
    });
    return updated;
  }

  async delete(context: AuthContext, templateId: string): Promise<void> {
    const template = await this.#requireEditable(context, templateId, 'template.delete');
    await this.store.agentTemplates.delete(templateId);
    await this.audit(context, {
      workspaceId: template.workspaceId ?? '',
      action: 'template.delete',
      resourceKind: 'agentTemplate',
      resourceId: templateId,
      outcome: 'allowed',
    });
  }

  /**
   * Build an agent from a template.
   *
   * Resolves the variables into the spec, then calls `AgentService.create`,
   * which validates the result as an `AgentVersion` and runs the same authz and
   * quota as any other agent creation. The template only supplies the shape.
   */
  async instantiate(
    context: AuthContext,
    templateId: string,
    input: InstantiateInput,
  ): Promise<Agent> {
    const template = await this.get(context, templateId);
    // Authorized as agent creation in the *target* workspace, which may differ
    // from the template's own (a built-in has none). `AgentService.create` does
    // the check too; doing it here as well means a denied caller never reaches
    // the substitution step with the template's contents.
    const workspace = await this.requireWorkspace(input.workspaceId);
    this.authorizer.require(context, workspace, 'template.instantiate');

    const values = resolveVariables(template.variables, input.variables ?? {});
    const spec = substitute(template.spec, values) as Record<string, unknown>;

    const agent = await this.#agents.create(context, {
      workspaceId: workspace.id,
      name: input.agentName ?? template.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      spec,
    });

    await this.audit(context, {
      workspaceId: workspace.id,
      action: 'template.instantiate',
      resourceKind: 'agent',
      resourceId: agent.id,
      outcome: 'allowed',
      reason: `instantiated from template ${templateId}`,
    });
    return agent;
  }

  /**
   * Install or refresh the platform's built-in templates.
   *
   * Idempotent by name: called at boot so the shipped catalogue stays current
   * without accumulating a copy per start. Not authorization-gated because it is
   * a platform operation, not a user request — there is no `AuthContext`.
   */
  async seedBuiltins(templates: readonly CreateTemplateInput[]): Promise<number> {
    const now = this.clock.now();
    let seeded = 0;
    for (const input of templates) {
      const template = parseOrThrow(agentTemplateSchema, {
        id: newId('agentTemplate', now),
        name: input.name,
        description: input.description ?? '',
        category: input.category ?? 'general',
        builtin: true,
        spec: input.spec,
        variables: input.variables ?? [],
        metadata: {},
        createdAt: now,
        updatedAt: now,
        createdBy: 'system',
      });
      assertVariablesConsistent(template.variables);
      await this.store.agentTemplates.upsertBuiltin(template);
      seeded++;
    }
    return seeded;
  }

  async #require(templateId: string): Promise<AgentTemplate> {
    const template = await this.store.agentTemplates.get(templateId);
    if (!template) throw notFound('AgentTemplate', templateId);
    return template;
  }

  /**
   * Fetch a template that the caller may modify.
   *
   * A built-in is never editable through the API: the platform owns it, and an
   * edited copy would be silently replaced on the next re-seed. A workspace
   * template needs the relevant write action on its workspace.
   */
  async #requireEditable(
    context: AuthContext,
    templateId: string,
    action: 'template.update' | 'template.delete',
  ): Promise<AgentTemplate> {
    const template = await this.#require(templateId);
    if (template.builtin || !template.workspaceId) {
      throw conflict('A built-in template cannot be modified', { templateId });
    }
    const workspace = await this.requireWorkspace(template.workspaceId);
    await this.requireOnResource(context, workspace, action, {
      kind: 'template',
      id: templateId,
    });
    return template;
  }
}

/**
 * Reject a variable set that cannot be substituted safely.
 *
 * Duplicate keys would make substitution order-dependent; the schema already
 * constrains each key to an identifier and each enum to a non-empty option list.
 */
function assertVariablesConsistent(variables: readonly TemplateVariable[]): void {
  const keys = variables.map((variable) => variable.key);
  if (new Set(keys).size !== keys.length) {
    throw validationError('Template variables contain a duplicate key');
  }
}

/**
 * Resolve supplied values against a template's variable declarations.
 *
 * A required variable with no supplied value and no default is an error — the
 * resulting spec would still contain an unsubstituted placeholder and fail
 * `AgentVersion` validation with a far less helpful message. An enum value
 * outside its option list is rejected here for the same reason.
 */
export function resolveVariables(
  declared: readonly TemplateVariable[],
  supplied: Record<string, unknown>,
): Map<string, unknown> {
  const resolved = new Map<string, unknown>();
  for (const variable of declared) {
    const has = Object.hasOwn(supplied, variable.key);
    let value = has ? supplied[variable.key] : variable.default;

    if (value === undefined) {
      if (variable.required) {
        throw validationError(`Template variable '${variable.key}' is required`);
      }
      // An optional variable with no value and no default substitutes to empty,
      // so an unset placeholder never survives into the spec.
      value = '';
    }

    value = coerce(variable, value);
    resolved.set(variable.key, value);
  }
  return resolved;
}

/** Coerce and validate one supplied value against its declared type. */
function coerce(variable: TemplateVariable, value: unknown): unknown {
  switch (variable.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) {
        throw validationError(`Template variable '${variable.key}' must be a number`);
      }
      return n;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : value === 'true';
    case 'enum': {
      const s = String(value);
      if (!variable.options.includes(s)) {
        throw validationError(
          `Template variable '${variable.key}' must be one of: ${variable.options.join(', ')}`,
        );
      }
      return s;
    }
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/**
 * Substitute `{{key}}` placeholders throughout a JSON value.
 *
 * A string that is *exactly* a single placeholder becomes the variable's raw
 * value, preserving its type — so a numeric variable can fill a numeric field.
 * A string with a placeholder embedded in other text becomes a string with the
 * value spliced in. Objects and arrays are walked recursively; object *keys* are
 * substituted too, so a variable can name a field.
 *
 * Exported for direct testing: the substitution rule is the whole feature and
 * deserves its own unit tests independent of the service.
 */
export function substitute(value: unknown, values: ReadonlyMap<string, unknown>): unknown {
  if (typeof value === 'string') return substituteString(value, values);
  if (Array.isArray(value)) return value.map((item) => substitute(item, values));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const substitutedKey = substituteString(key, values);
      out[typeof substitutedKey === 'string' ? substitutedKey : String(substitutedKey)] = substitute(
        item,
        values,
      );
    }
    return out;
  }
  return value;
}

/** `{{key}}` with optional surrounding whitespace, e.g. `{{ key }}`. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const SOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

function substituteString(text: string, values: ReadonlyMap<string, unknown>): unknown {
  // A string that is nothing but one placeholder yields the raw value, so a
  // `{{count}}` in a numeric field stays a number rather than becoming "5".
  const sole = SOLE_PLACEHOLDER.exec(text);
  if (sole) {
    const key = sole[1]!;
    return values.has(key) ? values.get(key) : text;
  }
  // Otherwise splice values in as text. An unknown key is left verbatim rather
  // than blanked, so a stray `{{typo}}` surfaces as a visible, debuggable string
  // instead of silently vanishing.
  return text.replace(PLACEHOLDER, (whole, key: string) =>
    values.has(key) ? String(values.get(key) ?? '') : whole,
  );
}
