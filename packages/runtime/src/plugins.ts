/**
 * Plugin manifests.
 *
 * A plugin is a packaged bundle that contributes tools by being unpacked (like a
 * skill archive) and launched as a local subprocess speaking MCP over stdio.
 * Its `plugin.json` declares how to start it: a command, its args, an env of
 * credential references, and an optional tool allowlist.
 *
 * Running a plugin as a subprocess rather than importing its code in-process is
 * deliberate: the subprocess is the isolation boundary, so a plugin never runs
 * with the agent-core process's own authority. It reuses the MCP substrate, so
 * "plugin contributes tools" and "MCP server contributes tools" are one path.
 */

/** A plugin's launch declaration, parsed from its `plugin.json`. */
export interface PluginManifest {
  name: string;
  version: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  toolAllowlist: string[];
}

/**
 * Parse a bundle's `plugin.json`.
 *
 * Returns `undefined` when the JSON is malformed or declares no command — a
 * plugin with no runnable command contributes nothing, and saying so lets the
 * caller skip it rather than launch a broken process.
 */
export function parsePluginManifest(bytes: Uint8Array, fallbackName = 'plugin'): PluginManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const p = parsed as Record<string, unknown>;
  if (typeof p.command !== 'string' || p.command.length === 0) return undefined;

  return {
    name: typeof p.name === 'string' && p.name.length > 0 ? p.name : fallbackName,
    version: typeof p.version === 'string' ? p.version : '',
    command: p.command,
    args: Array.isArray(p.args) ? p.args.filter((a): a is string => typeof a === 'string') : [],
    env:
      typeof p.env === 'object' && p.env !== null
        ? Object.fromEntries(
            Object.entries(p.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {},
    toolAllowlist: Array.isArray(p.toolAllowlist)
      ? p.toolAllowlist.filter((t): t is string => typeof t === 'string')
      : [],
  };
}
