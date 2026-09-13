/**
 * Workspace-confined sandbox identity.
 *
 * An agent version may declare `sandbox.runAs` — a cloud (service-account)
 * identity the sandbox runs under. This is the one place that turns that
 * requested identity into a concrete Kubernetes ServiceAccount name, and it
 * confines every such name to the requesting workspace:
 *
 *   <workspaceId, lower-cased, ULID '_' → '-'>-<runAs>
 *
 * — the same defence-by-construction the volume store uses for paths, and for
 * the same reason: a workspace can only ever name a ServiceAccount whose name
 * begins with its own prefix, never `default`, never a cluster-admin account,
 * never another workspace's. Both inputs are validated here rather than trusted
 * from the spec, because this is the function that turns strings into a cluster
 * identity. A value that would escape the workspace prefix is refused, not
 * clamped.
 *
 * The produced name is a valid DNS-1123 subdomain (Kubernetes' rule for a
 * ServiceAccount name): the prefix is `ws-` + 26 lower-cased ULID characters
 * (29 chars), and `runAs` is already a single DNS-1123 label (≤63), so the
 * join is ≤93 characters and free of any character outside `[a-z0-9-]`.
 *
 * Collision-freedom is load-bearing and rests on ONE structural fact: the
 * workspace segment is fixed-width. `WORKSPACE_ID` forces exactly 26 characters,
 * so the workspace always occupies the constant window `[3, 29)` and `runAs`
 * always begins at index 30 — making `(workspace, runAs) → name` injective, with
 * no prefix ambiguity even when `runAs` itself contains dashes. If workspace ids
 * ever become variable-length, this guarantee breaks and the confinement must be
 * redesigned (e.g. a delimiter that cannot appear in either component).
 */

import { MaError } from '@ma/core';

/**
 * The workspace ULID form. The 26-char body is Crockford base32 (no I/L/O/U),
 * matching `newId`'s own alphabet in `@ma/core` rather than a looser `[0-9A-Z]`,
 * so this rejects exactly what the platform never mints. The fixed 26-char width
 * is load-bearing for collision-freedom (see the module docstring).
 */
const WORKSPACE_ID = /^ws_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/**
 * A single DNS-1123 label: the shape `sandboxSpecSchema.runAs` already enforces.
 * Re-checked here so this function is safe on any caller, not only a parsed spec.
 */
const RUN_AS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Turn a requested `runAs` into the ServiceAccount name the sandbox may use,
 * confined to its workspace.
 *
 * Throws when the workspace id is not a workspace ULID, or when `runAs` is empty
 * or not a single DNS-1123 label — callers only reach here for a non-empty
 * `runAs`, so an empty value is a programming error, refused rather than
 * silently mapped to the bare workspace prefix.
 */
export function confineServiceAccount(workspaceId: string, runAs: string): string {
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new MaError({
      code: 'IDENTITY_BAD_WORKSPACE',
      category: 'validation',
      message: 'A sandbox identity workspace id must be a workspace ULID',
    });
  }
  if (!RUN_AS_LABEL.test(runAs)) {
    throw new MaError({
      code: 'IDENTITY_BAD_RUN_AS',
      category: 'validation',
      message: 'runAs must be a single DNS-1123 label',
    });
  }
  // ULIDs are `[0-9A-Z]`; lower-case them and turn the `ws_` separator into a
  // dash so the whole name is a valid DNS-1123 subdomain. The regexes above
  // already forbid every other character, so this cannot introduce one.
  const prefix = workspaceId.toLowerCase().replace(/_/g, '-');
  return `${prefix}-${runAs}`;
}
