/**
 * Skill materialization for the runtime.
 *
 * A skill is author-supplied instructions (and, later, resources and tools)
 * that a running agent gains. The simplest skill is a single `SKILL.md` with a
 * YAML-ish frontmatter block naming it, followed by the instruction body.
 *
 * The instruction body is *author-controlled text*, so it is injected into the
 * system prompt in the same trust position as workspace policy and human-written
 * memory — never as tool output. (Agent-authored content stays out of the
 * prompt; that boundary is enforced elsewhere.)
 */

/** A skill's declared metadata, parsed from its manifest frontmatter. */
export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  /** Tool names the skill contributes (wired in a later slice). */
  tools: string[];
}

export interface ParsedSkill {
  manifest: SkillManifest;
  /** The instruction body after the frontmatter. */
  body: string;
}

/** Cap on a single skill's injected size, so one skill cannot dominate the prompt. */
const MAX_SKILL_CHARS = 16_000;

/**
 * Parse a single-file skill (`SKILL.md`).
 *
 * Frontmatter is a leading `---\n … \n---\n` block of `key: value` lines. Only a
 * small, fixed key set is read; unknown keys are ignored rather than failing, so
 * a richer manifest from a newer author does not break an older runtime. The
 * name falls back to a supplied default (the capability ref's name) when the
 * frontmatter omits it.
 */
export function parseSkillManifest(bytes: Uint8Array, fallbackName = 'skill'): ParsedSkill {
  const text = new TextDecoder().decode(bytes);
  const manifest: SkillManifest = { name: fallbackName, description: '', version: '', tools: [] };
  let body = text;

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      const key = kv[1]!.toLowerCase();
      const value = kv[2]!.trim();
      if (key === 'name' && value) manifest.name = value;
      else if (key === 'description') manifest.description = value;
      else if (key === 'version') manifest.version = value;
      else if (key === 'tools') {
        manifest.tools = value
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
      }
    }
  }

  return { manifest, body: body.trim() };
}

/**
 * Format installed skills as a system-prompt section.
 *
 * Each skill is advertised by name and description, then its instruction body,
 * so the agent knows what it can do and how. Total size is bounded per skill;
 * an over-long body is truncated with a visible marker rather than silently cut.
 */
export function formatSkillInstructions(skills: readonly ParsedSkill[]): string {
  if (skills.length === 0) return '';
  const parts = skills.map((skill) => {
    const header = skill.manifest.description
      ? `## Skill: ${skill.manifest.name}\n${skill.manifest.description}`
      : `## Skill: ${skill.manifest.name}`;
    let body = skill.body;
    if (body.length > MAX_SKILL_CHARS) {
      body = `${body.slice(0, MAX_SKILL_CHARS)}\n… (skill instructions truncated)`;
    }
    return body ? `${header}\n\n${body}` : header;
  });
  return `# Installed skills\n\n${parts.join('\n\n')}`;
}
