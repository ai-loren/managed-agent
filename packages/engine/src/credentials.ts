/**
 * Credential service.
 *
 * The design rule is one sentence: **a credential value goes in and never comes
 * back out through the API.** Only `exchange` decrypts, only the runtime calls
 * it, and every call is audited with what was accessed and why.
 *
 * Ciphertext is bound to its credential id as additional authenticated data, so
 * a row copied into another record fails to decrypt rather than quietly
 * granting that record someone else's secret.
 */

import {
  credentialEnvKeys,
  findCredentialEnvKeyCollision,
  newId,
  notFound,
  permissionDenied,
  preconditionFailed,
  seal,
  unseal,
  validationError,
  type KeyProvider,
} from '@ma/core';
import type { Credential, CredentialOwnerType, CredentialType, Session } from '@ma/contracts';
import type { Page, PageRequest } from '@ma/store';

import { BaseService, type ServiceDeps } from './agents.ts';
import type { AuthContext } from './authz.ts';

export interface CredentialServiceDeps extends ServiceDeps {
  keys: KeyProvider;
}

export interface CreateCredentialInput {
  workspaceId: string;
  ownerType: CredentialOwnerType;
  ownerId?: string;
  type: CredentialType;
  name: string;
  description?: string;
  /** The secret. Never logged, never echoed, never returned. */
  value: string;
  expiresAt?: number;
  /**
   * For `env_vars`: the variable names, so the console can show what an agent
   * will receive without revealing any value.
   */
  valueKeys?: string[];
}

export class CredentialService extends BaseService {
  readonly #keys: KeyProvider;

  constructor(deps: CredentialServiceDeps) {
    super(deps);
    this.#keys = deps.keys;
  }

  async create(context: AuthContext, input: CreateCredentialInput): Promise<Credential> {
    const workspace = await this.requireWorkspace(input.workspaceId);
    this.authorizer.require(context, workspace, 'credential.create');

    if (input.value.length === 0) throw validationError('A credential value must not be empty');
    await this.#assertNoEnvKeyCollision(input.workspaceId, input.ownerType, input.ownerId ?? workspace.id, input.name);

    const now = this.clock.now();
    const id = newId('credential', now);
    // The id is the AAD, so this ciphertext is only ever valid on this row.
    const sealed = seal(input.value, this.#keys, id);

    const credential: Credential = {
      id,
      workspaceId: workspace.id,
      ownerType: input.ownerType,
      ownerId: input.ownerId ?? workspace.id,
      type: input.type,
      name: input.name,
      description: input.description ?? '',
      status: 'active',
      keyVersion: sealed.keyVersion,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      valueKeys: input.valueKeys ?? [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: context.principal.id,
    };

    const created = await this.store.credentials.create(
      credential,
      JSON.stringify({ ...sealed }),
    );

    await this.audit(context, {
      workspaceId: workspace.id,
      action: 'credential.create',
      resourceKind: 'credential',
      resourceId: created.id,
      outcome: 'allowed',
      details: { type: created.type, ownerType: created.ownerType },
    });
    return created;
  }

  async get(context: AuthContext, credentialId: string): Promise<Credential> {
    const credential = await this.store.credentials.get(credentialId);
    if (!credential) throw notFound('Credential', credentialId);
    const workspace = await this.requireWorkspace(credential.workspaceId);
    await this.requireOnResource(context, workspace, 'credential.read', {
      kind: 'credential',
      id: credentialId,
    });
    return credential;
  }

  async list(
    context: AuthContext,
    filter: { workspaceId: string; ownerType?: CredentialOwnerType; ownerId?: string } & PageRequest,
  ): Promise<Page<Credential>> {
    const workspace = await this.requireWorkspace(filter.workspaceId);
    this.authorizer.require(context, workspace, 'credential.read');
    return this.store.credentials.list(filter);
  }

  /** Rotate the value, or update metadata. Both re-seal under the current key. */
  async update(
    context: AuthContext,
    credentialId: string,
    patch: { name?: string; description?: string; value?: string; expiresAt?: number },
  ): Promise<Credential> {
    const credential = await this.get(context, credentialId);
    const workspace = await this.requireWorkspace(credential.workspaceId);
    await this.requireOnResource(context, workspace, 'credential.update', {
      kind: 'credential',
      id: credentialId,
    });

    // A rename must not collide with another credential's materialised env key.
    // Workspace-wide, not owner-scoped: the check is against what one session
    // actually materialises, and a session pins across owners.
    if (patch.name !== undefined && patch.name !== credential.name) {
      await this.#assertRenameNoWorkspaceCollision(credential.workspaceId, {
        ...credential,
        name: patch.name,
      });
    }

    const now = this.clock.now();
    const metadataPatch: Partial<Credential> = {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.expiresAt === undefined ? {} : { expiresAt: patch.expiresAt }),
      updatedAt: now,
    };

    let sealedJson: string | undefined;
    if (patch.value !== undefined) {
      if (patch.value.length === 0) throw validationError('A credential value must not be empty');
      if (credential.status === 'revoked') {
        // Revocation is terminal: a value rotation must not silently restore a
        // revoked credential (the previous unconditional status='active' did,
        // re-opening access a revocation was meant to close for good). Create a
        // new credential instead.
        throw preconditionFailed('A revoked credential cannot be rotated; create a new credential', {
          credentialId,
        });
      }
      const sealed = seal(patch.value, this.#keys, credentialId);
      sealedJson = JSON.stringify(sealed);
      metadataPatch.keyVersion = sealed.keyVersion;
      // Rotating the value clears an expired/expiring flag (but never revoked).
      if (credential.status === 'expired' || credential.status === 'expiring') {
        metadataPatch.status = 'active';
      }
    }

    const updated = await this.store.credentials.update(credentialId, metadataPatch, sealedJson);
    await this.audit(context, {
      workspaceId: workspace.id,
      action: 'credential.update',
      resourceKind: 'credential',
      resourceId: credentialId,
      outcome: 'allowed',
      details: { rotated: patch.value !== undefined },
    });
    return updated;
  }

  async delete(context: AuthContext, credentialId: string, reason: string): Promise<void> {
    const credential = await this.get(context, credentialId);
    const workspace = await this.requireWorkspace(credential.workspaceId);
    await this.requireOnResource(context, workspace, 'credential.delete', {
      kind: 'credential',
      id: credentialId,
    });

    await this.store.credentials.delete(credentialId);
    await this.audit(context, {
      workspaceId: workspace.id,
      action: 'credential.delete',
      resourceKind: 'credential',
      resourceId: credentialId,
      outcome: 'allowed',
      reason,
    });
  }

  /**
   * Whether a credential's plaintext may be used right now. The non-throwing
   * form of {@link #assertUsable}: a revoked/expired status, or an `expiresAt`
   * in the past (the lazy window before the expiry sweep), is unusable;
   * `expiring` is still a live warning, not a revocation.
   */
  isUsable(credential: Credential): boolean {
    if (credential.status === 'revoked' || credential.status === 'expired') return false;
    if (credential.expiresAt !== undefined && credential.expiresAt <= this.clock.now()) {
      return false;
    }
    return true;
  }

  /**
   * The single "may this credential's plaintext be used right now" gate, shared
   * by every unseal path. Throwing form of {@link isUsable}.
   */
  #assertUsable(credential: Credential): void {
    if (!this.isUsable(credential)) {
      throw validationError(
        credential.status === 'revoked' || credential.status === 'expired'
          ? `This credential is ${credential.status}`
          : 'This credential has expired',
        { credentialId: credential.id },
      );
    }
  }

  /**
   * Decrypt a credential for a running session.
   *
   * This is the only method that returns plaintext, and it is not reachable
   * from the public API — the runtime calls it over the internal transport with
   * a session-scoped token. The session must actually be granted the credential
   * on its *pinned version*, so widening an agent's credentials does not
   * retroactively widen sessions already running.
   */
  async exchange(session: Session, credentialId: string, purpose: string): Promise<string> {
    if (!session.credentialIds.includes(credentialId)) {
      throw permissionDenied('exchange', credentialId);
    }

    const credential = await this.store.credentials.get(credentialId);
    if (!credential) throw notFound('Credential', credentialId);
    if (credential.workspaceId !== session.workspaceId) {
      // Defence in depth: a session must never reach across workspaces even if
      // its credential list somehow named a foreign id.
      throw permissionDenied('exchange', credentialId);
    }
    this.#assertUsable(credential);
    const now = this.clock.now();
    const sealedJson = await this.store.credentials.getSealed(credentialId);
    if (!sealedJson) throw notFound('Credential', credentialId);
    const value = unseal(JSON.parse(sealedJson), this.#keys, credentialId);

    await this.store.credentials.markUsed(credentialId, now);
    await this.store.audit.append({
      id: newId('auditEntry', now),
      workspaceId: session.workspaceId,
      principalId: `session:${session.id}`,
      action: 'credential.exchange',
      resourceKind: 'credential',
      resourceId: credentialId,
      outcome: 'allowed',
      reason: purpose,
      requestId: '',
      sourceIp: '',
      details: { sessionId: session.id },
      at: now,
    });

    return value;
  }

  /**
   * Unseal a connector's own secret (a webhook signing key, a bot token).
   *
   * Separate from `exchange` because there is no session to authorize against:
   * the caller is the delivery pipeline verifying an inbound signature, not an
   * agent asking for a credential. Kept narrow deliberately — it takes the
   * already-fetched credential and ciphertext, so it cannot be used to
   * enumerate credentials.
   *
   * It runs the SAME liveness gate as `exchange` (`#assertUsable`): a connector
   * must stop accepting deliveries signed by a key that has been revoked or has
   * reached its `expiresAt`. Without it the connector path was a bare decrypt
   * and a retired signing key authenticated inbound traffic indefinitely.
   */
  unsealForConnector(credential: Credential, sealedJson: string): string {
    this.#assertUsable(credential);
    return unseal(JSON.parse(sealedJson), this.#keys, credential.id);
  }

  /**
   * Sweep for credentials at or past expiry and mark them.
   *
   * Proactive rather than lazy: an agent should learn its credential is about
   * to lapse from a warning, not from a failed run at 3am.
   */
  async sweepExpiry(workspaceId: string, warnWithinMs = 7 * 24 * 60 * 60 * 1000): Promise<{
    expired: number;
    expiring: number;
  }> {
    const now = this.clock.now();
    let expired = 0;
    let expiring = 0;
    let cursor: string | undefined;

    do {
      const page = await this.store.credentials.list({
        workspaceId,
        expiringBefore: now + warnWithinMs,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });

      for (const credential of page.items) {
        if (credential.expiresAt === undefined || credential.status === 'revoked') continue;
        const next = credential.expiresAt <= now ? 'expired' : 'expiring';
        if (credential.status === next) continue;
        await this.store.credentials.update(credential.id, { status: next, updatedAt: now });
        if (next === 'expired') expired++;
        else expiring++;
      }
      cursor = page.nextCursor;
    } while (cursor);

    return { expired, expiring };
  }

  /**
   * Reject a credential name that would materialise onto the same environment key
   * as another credential in the same owner scope.
   *
   * A name is lossily normalised to `MA_CRED_<UPPER>` (and `..._FILE` for a
   * file/ssh_key), so `github-token` and `github_token` both become
   * `MA_CRED_GITHUB_TOKEN`, and a file cred `foo` collides with an api_key
   * `foo_file` on `MA_CRED_FOO_FILE`. At materialisation the later write silently
   * overwrote the earlier — one credential vanished, or a value landed under a key
   * documented as a path. Reject at create/rename instead, so the ambiguity never
   * reaches the sandbox. Scoped to the owner (workspace + ownerType + ownerId),
   * matching how credentials are materialised for a session.
   */
  async #assertNoEnvKeyCollision(
    workspaceId: string,
    ownerType: CredentialOwnerType,
    ownerId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const mine = credentialEnvKeys(name);
    let cursor: string | undefined;
    do {
      const page: Page<Credential> = await this.store.credentials.list({
        workspaceId,
        ownerType,
        ownerId,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const other of page.items) {
        if (other.id === excludeId || other.status === 'revoked') continue;
        const theirs = credentialEnvKeys(other.name);
        // Any overlap between the two forms {value, file} is a collision.
        if (
          mine.value === theirs.value ||
          mine.value === theirs.file ||
          mine.file === theirs.value ||
          mine.file === theirs.file
        ) {
          throw validationError(
            `A credential named '${other.name}' already maps to the same environment key as '${name}'; choose a name that differs by more than case or punctuation`,
          );
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  /**
   * Workspace-wide, type-aware collision check for a credential that ALREADY
   * EXISTS and is being renamed. Creation is checked owner-scoped, but the owner
   * label is not an isolation boundary at materialisation (one session pins
   * credentials across owners), so a rename must be checked against EVERY
   * credential in the workspace — otherwise a pinned credential can be renamed
   * onto another owner's pinned `MA_CRED_*` key after admission, reopening a
   * silent overwrite at the next provision/rebind. Uses the exact delivered
   * (type-aware) key set with the candidate in place of itself.
   */
  async #assertRenameNoWorkspaceCollision(
    workspaceId: string,
    candidate: Credential,
  ): Promise<void> {
    const others: Credential[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.credentials.list({
        workspaceId,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const other of page.items) {
        if (other.id !== candidate.id) others.push(other);
      }
      cursor = page.nextCursor;
    } while (cursor);
    const collision = findCredentialEnvKeyCollision(
      [...others, candidate],
      this.clock.now(),
    );
    if (collision) {
      throw validationError(
        `Renaming to '${candidate.name}' collides with '${collision.nameA === candidate.name ? collision.nameB : collision.nameA}', which delivers the same environment key ${collision.envKey}; choose a name that differs by more than case or punctuation`,
      );
    }
  }
}
