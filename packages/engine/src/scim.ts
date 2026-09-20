/**
 * SCIM 2.0 user provisioning.
 *
 * OIDC answers "who is this at login". SCIM answers the lifecycle question OIDC
 * cannot: an IdP pushes create / update / deactivate / delete of users to the
 * platform, so an account can exist (and be granted workspace roles) *before* a
 * first login, and — the security payoff — is deactivated the moment HR removes
 * the person from the IdP, rather than staying live until their last token
 * happens to expire.
 *
 * The design converges with OIDC on one principal. SCIM provisions into the same
 * `oidc:<provider>:<externalId>` subject that a login later matches (see
 * `federation.ts`), so provision-ahead, login, and deactivate all act on the one
 * identity. Deactivation sets `principal.disabled` *and* revokes every live API
 * key the principal holds — the auth middleware rejects a disabled principal and
 * a revoked key on the very next request, so offboarding is immediate.
 *
 * This is a translation layer, not a new store: a SCIM `User` is a projection of
 * a `Principal`. Only the fields the platform actually acts on are honoured
 * (`userName`, `externalId`, `active`, name, email); the rest of the SCIM schema
 * is accepted and echoed but not invented into behaviour.
 */

import { hashToken, newId, randomToken, safeEqual, type Clock, type Logger } from '@ma/core';
import type { Principal } from '@ma/contracts';
import type { Store } from '@ma/store';

import { federatedSubject } from './federation.ts';

export interface ScimServiceDeps {
  clock: Clock;
  store: Store;
  logger?: Logger;
  /**
   * The bearer token the IdP presents on every SCIM call. Absent disables SCIM
   * entirely — the routes refuse rather than run unauthenticated. Compared
   * constant-time.
   */
  token?: string;
  /**
   * The provider id SCIM provisions under, so its subjects match the OIDC
   * provider of the same name. Required when a token is set; without it a
   * provisioned user could never converge with a login.
   */
  providerId?: string;
  /** Page size cap for list responses. */
  maxPageSize?: number;
}

/** A SCIM User resource, the subset the platform reads and emits. */
export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  active: boolean;
  name?: { formatted?: string; givenName?: string; familyName?: string };
  displayName?: string;
  emails?: { value: string; primary?: boolean; type?: string }[];
  meta: { resourceType: 'User'; created?: string; lastModified?: string; location?: string };
}

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const DEFAULT_MAX_PAGE = 100;

/**
 * A typed SCIM error. Carries the SCIM `status` (as a string, per the spec) and
 * an optional `scimType`, and maps to the right HTTP status at the route. Kept
 * distinct from `MaError` because the SCIM error *body* has its own schema an IdP
 * parses.
 */
export class ScimError extends Error {
  readonly status: number;
  readonly scimType: string | undefined;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.name = 'ScimError';
    this.status = status;
    this.scimType = scimType;
  }
  body(): Record<string, unknown> {
    return {
      schemas: [ERROR_SCHEMA],
      status: String(this.status),
      ...(this.scimType ? { scimType: this.scimType } : {}),
      detail: this.message,
    };
  }
}

export class ScimService {
  readonly #clock: Clock;
  readonly #store: Store;
  readonly #logger: Logger | undefined;
  readonly #token: string | undefined;
  readonly #providerId: string | undefined;
  readonly #maxPage: number;
  /** A random token compared against when SCIM is disabled, to keep `authorize`
   * uniform in timing and outcome whether or not SCIM is configured. */
  readonly #disabledDummyToken = randomToken(32);

  constructor(deps: ScimServiceDeps) {
    this.#clock = deps.clock;
    this.#store = deps.store;
    this.#logger = deps.logger;
    this.#token = deps.token;
    this.#providerId = deps.providerId;
    this.#maxPage = deps.maxPageSize ?? DEFAULT_MAX_PAGE;
  }

  /** Whether SCIM is configured (a token and a provider id are both present). */
  get enabled(): boolean {
    return this.#token !== undefined && this.#providerId !== undefined;
  }

  /**
   * Authorise a SCIM request by its bearer token, constant-time.
   *
   * Throws a 401 when SCIM is disabled or the token does not match — never a
   * "SCIM is off" that an unauthenticated caller could distinguish from a wrong
   * token, so the surface reveals nothing to a prober.
   */
  authorize(bearer: string | undefined): void {
    // A disabled service and a wrong token must be indistinguishable to a prober
    // — same message, and the same work — so the surface never reveals whether
    // SCIM is configured. When disabled there is no real token, so compare
    // against a random one to keep the timing and the outcome uniform.
    const expected = this.#token ?? this.#disabledDummyToken;
    const configured = this.#token !== undefined && this.#providerId !== undefined;
    const matches =
      typeof bearer === 'string' && bearer.length > 0 && safeEqual(bearer, expected);
    if (!configured || !matches) {
      throw new ScimError(401, 'Invalid SCIM credentials');
    }
  }

  // --- User operations ------------------------------------------------------

  /**
   * Create (or reactivate) a user. Idempotent on `externalId`/`userName`: an IdP
   * that retries a create, or provisions someone who already exists from an
   * earlier login, gets the existing principal back rather than a duplicate — a
   * 409 only when the caller supplied no externalId to key on.
   */
  async createUser(payload: unknown): Promise<{ user: ScimUser; created: boolean }> {
    const input = this.#parseUser(payload);
    // `externalId` is the convergence key — it MUST equal the value the IdP will
    // assert as the OIDC token `sub`, or a SCIM-provisioned user and their later
    // login land on two different principals (and an offboard would then revoke
    // the wrong one's tokens). `userName` is a human login label (an email), not
    // the opaque stable id, so it is never used as the key: falling back to it
    // would silently guarantee divergence. Refuse rather than mis-provision.
    const externalId = input.externalId;
    if (!externalId) {
      throw new ScimError(
        400,
        'An externalId is required: it is the stable id that links this user to their login (the OIDC sub).',
        'invalidValue',
      );
    }
    const userName = input.userName ?? externalId;
    const subject = this.#subject(externalId);
    const now = this.#clock.now();

    const existing = await this.#store.principals.getBySubject(subject);
    if (existing) {
      // Idempotent create: converge on the existing principal, refreshing profile.
      const patch: Partial<Principal> = { updatedAt: now };
      if (input.displayName && input.displayName !== existing.displayName) patch.displayName = input.displayName;
      if (input.email && input.email !== existing.email) patch.email = input.email;
      // Reactivate only a principal SCIM itself deactivated — never clear an
      // admin's deliberate disable — and, when reactivating, the caller is
      // asserting this identity is live again, so a fresh set of keys will be
      // minted at next login; existing revoked keys stay revoked.
      if (input.active !== false && existing.disabled && this.#scimDeactivated(existing)) {
        patch.disabled = false;
        patch.metadata = this.#clearDeactivated(existing);
        await this.#revokeKeysOnReactivation(existing.id);
      } else if (input.active === false && !existing.disabled) {
        // An idempotent create carrying active:false on a still-enabled principal
        // is a deactivation directive and must be honoured — same as PUT/PATCH.
        // Dropping it (only refreshing the profile) left a user the IdP asked to
        // disable fully enabled with live keys. #deactivate revokes keys, stamps
        // the SCIM marker, and audits; skip the redundant profile update below.
        await this.#deactivate(existing, 'scim.user.create');
        const refreshed = (await this.#store.principals.get(existing.id))!;
        return { user: this.#toScim(refreshed), created: false };
      }
      const updated = await this.#store.principals.update(existing.id, patch);
      await this.#audit('scim.user.create', updated, 'allowed', { externalId, idempotent: true });
      return { user: this.#toScim(updated), created: false };
    }

    let principal: Principal;
    try {
      principal = await this.#store.principals.create({
        id: newId('principal', now),
        type: 'user',
        subject,
        displayName: input.displayName ?? '',
        email: input.email ?? '',
        // SCIM never grants platform-admin — the same rule OIDC holds. Admin is a
        // deliberate out-of-band grant, never asserted by an external system.
        isAdmin: false,
        // If the IdP creates a user already inactive, honour it: they exist but
        // cannot authenticate until a later activate. Stamp the SCIM-deactivation
        // marker so that later activate is actually possible — reactivation is
        // gated on `#scimDeactivated` (to never clear an *admin's* disable), and
        // without the marker a create-inactive user would be indistinguishable
        // from an admin disable and could never be enabled through any SCIM path.
        disabled: input.active === false,
        metadata: {
          'scim:externalId': externalId,
          'scim:userName': userName,
          ...(input.active === false ? { 'scim:deactivatedAt': String(now) } : {}),
        },
        createdAt: now,
        updatedAt: now,
        createdBy: 'scim',
      });
    } catch (error) {
      // A concurrent create of the same externalId loses the race on the subject
      // UNIQUE constraint. Converge on the winner rather than surfacing a raw
      // conflict — the documented idempotency must hold under concurrency too.
      const raced = await this.#store.principals.getBySubject(subject);
      if (raced) {
        await this.#audit('scim.user.create', raced, 'allowed', { externalId, idempotent: true, raced: true });
        return { user: this.#toScim(raced), created: false };
      }
      throw error;
    }
    await this.#audit('scim.user.create', principal, 'allowed', { externalId });
    return { user: this.#toScim(principal), created: true };
  }

  /** Fetch a user by platform principal id. */
  async getUser(id: string): Promise<ScimUser> {
    const principal = await this.#requirePrincipal(id);
    return this.#toScim(principal);
  }

  /**
   * List users, honouring the one filter IdPs actually send before a create:
   * `userName eq "x"` / `externalId eq "x"`. Any other filter is refused rather
   * than silently returning everything (which an IdP would read as "no match,
   * safe to create", producing a duplicate).
   */
  async listUsers(query: URLSearchParams): Promise<{
    schemas: string[];
    totalResults: number;
    startIndex: number;
    itemsPerPage: number;
    Resources: ScimUser[];
  }> {
    const filter = query.get('filter');
    if (filter) {
      const match = this.#parseEqFilter(filter);
      if (match.attribute.toLowerCase() === 'externalid') {
        // externalId is the subject key — an indexed exact lookup.
        const principal = await this.#store.principals.getBySubject(this.#subject(match.value));
        const resources =
          principal && this.#belongsToProvider(principal) ? [this.#toScim(principal)] : [];
        return this.#listResponse(resources);
      }
      // userName is stored in metadata, which the repository cannot query, so it
      // is matched by a bounded scan of this provider's principals. An IdP sends
      // this probe for exactly one userName before a create, so a match short-
      // circuits; the scan is bounded by maxPage to stay predictable.
      const matches = await this.#findByUserName(match.value);
      return this.#listResponse(matches.map((principal) => this.#toScim(principal)));
    }
    // No filter: page through this provider's provisioned users, honouring
    // startIndex/count. The previous version fetched a single maxPage-capped page
    // and only THEN filtered by provider — so on a multi-provider deployment,
    // other providers' principals occupied slots in that one page and this
    // provider's real users could fall off it entirely, invisible to a full sync.
    // Filter WHILE paging (like #findByUserName) so the page cap bounds the scan,
    // not the result, and skip `startIndex - 1` provider matches so a client can
    // page through every provisioned user.
    const startIndex = Math.max(1, Number(query.get('startIndex') ?? 1) || 1);
    // Parse and clamp `count` explicitly rather than `Number(...) || maxPage`: an
    // IdP may send count=0 as the RFC 7644 §3.4.2.4 probe (return zero resources,
    // just totalResults), and `0 || maxPage` swallows the zero and returns a whole
    // page the client never asked for. Honour a finite count in [0, maxPage];
    // anything absent/NaN/negative falls back to the page ceiling. (A negative
    // clamps to 0, which is the safe reading — no resources — for a nonsensical
    // count.)
    const rawCount = Number(query.get('count') ?? this.#maxPage);
    const count = Number.isFinite(rawCount)
      ? Math.min(Math.max(Math.trunc(rawCount), 0), this.#maxPage)
      : this.#maxPage;
    const skip = startIndex - 1;
    const matched: Principal[] = [];
    let seen = 0;
    // Count of this provider's users across the whole scan — reported as
    // `totalResults` (distinct from the returned page length) so a spec-compliant
    // IdP that pages until it has seen `totalResults` resources fetches every user
    // rather than stopping after the first page. Bounded by the same page ceiling
    // as the result, so a huge directory reports a floor, never an unbounded scan.
    let providerTotal = 0;
    let cursor: string | undefined;
    // Scope the scan to THIS provider's subjects (`oidc:<providerId>:`) so the page
    // budget below counts only this provider's users — a large multi-provider
    // directory does not exhaust it on other providers before reaching ours.
    const subjectPrefix = `oidc:${this.#providerId}:`;
    // Hard page ceiling so a huge or hostile directory cannot turn a list into an
    // unbounded scan; a client that needs more pages with a higher startIndex.
    for (let pages = 0; pages < 100; pages++) {
      const page = await this.#store.principals.list({
        limit: this.#maxPage,
        subjectPrefix,
        ...(cursor ? { cursor } : {}),
      });
      for (const principal of page.items) {
        if (!this.#belongsToProvider(principal)) continue;
        providerTotal++;
        if (seen++ < skip) continue; // page past everything before startIndex
        if (matched.length < count) matched.push(principal);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return this.#listResponse(
      matched.map((principal) => this.#toScim(principal)),
      startIndex,
      providerTotal,
    );
  }

  /**
   * Replace a user (PUT). Used by IdPs that PUT the full resource rather than
   * PATCH. `active:false` here deactivates exactly as a PATCH would.
   */
  async replaceUser(id: string, payload: unknown): Promise<ScimUser> {
    const principal = await this.#requirePrincipal(id);
    const input = this.#parseUser(payload);
    const now = this.#clock.now();

    // Deactivation goes fully through #deactivate (revoke keys + mark + disable),
    // so its metadata marker is not clobbered by a follow-up write.
    if (input.active === false) {
      if (!principal.disabled) await this.#deactivate(principal, 'scim.user.replace');
      // Apply profile fields without touching the disabled/marker state.
      const updated = await this.#store.principals.update(id, {
        displayName: input.displayName ?? '',
        email: input.email ?? '',
        updatedAt: this.#clock.now(),
      });
      return this.#toScim(updated);
    }

    const patch: Partial<Principal> = {
      displayName: input.displayName ?? '',
      email: input.email ?? '',
      updatedAt: now,
    };
    // Reactivate only a SCIM-deactivated principal; never clear an admin disable.
    if (principal.disabled && this.#scimDeactivated(principal)) {
      patch.disabled = false;
      patch.metadata = this.#clearDeactivated(principal);
      await this.#revokeKeysOnReactivation(principal.id);
    }
    const updated = await this.#store.principals.update(principal.id, patch);
    return this.#toScim(updated);
  }

  /**
   * Patch a user (PATCH PatchOp). The operation that matters is
   * `replace active=false` — the standard deactivate an IdP sends on offboarding.
   */
  async patchUser(id: string, payload: unknown): Promise<ScimUser> {
    const principal = await this.#requirePrincipal(id);
    const ops = this.#parsePatch(payload);
    const now = this.#clock.now();
    const profile: Partial<Principal> = { updatedAt: now };
    // `undefined` = the patch expressed no active change; true/false otherwise.
    let activeChange: boolean | undefined;

    for (const op of ops) {
      const path = (op.path ?? '').toLowerCase();
      const verb = (op.op ?? '').toLowerCase();
      if (verb === 'remove' && path === 'active') {
        // Some IdPs express deactivate as a remove of `active`.
        activeChange = false;
        continue;
      }
      if (path === 'active' || (path === '' && op.value && typeof op.value === 'object')) {
        const active = this.#activeFromPatchValue(path, op.value);
        if (active !== undefined) activeChange = active;
      }
      if (path === 'displayname' && typeof op.value === 'string') profile.displayName = op.value;
    }

    // Deactivate through #deactivate (revoke + mark + disable), then apply profile
    // fields without clobbering the marker.
    if (activeChange === false) {
      if (!principal.disabled) await this.#deactivate(principal, 'scim.user.patch');
      const updated = await this.#store.principals.update(id, profile);
      return this.#toScim(updated);
    }
    // Reactivate only a SCIM-deactivated principal; never clear an admin disable.
    if (activeChange === true && principal.disabled && this.#scimDeactivated(principal)) {
      profile.disabled = false;
      profile.metadata = this.#clearDeactivated(principal);
      await this.#revokeKeysOnReactivation(principal.id);
    }
    const updated = await this.#store.principals.update(principal.id, profile);
    return this.#toScim(updated);
  }

  /**
   * Delete a user. Treated as deactivation, not a row deletion: the principal
   * owns audit history and possibly workspace memberships, and hard-deleting it
   * would orphan those and let a re-provision silently re-use the id. Disabling +
   * revoking tokens is the immediate, reversible, audit-preserving offboard.
   */
  async deleteUser(id: string): Promise<void> {
    const principal = await this.#requirePrincipal(id);
    // #deactivate revokes keys, marks, and writes disabled. If already disabled,
    // still ensure keys are revoked (a prior admin disable may not have) and the
    // SCIM marker is set, so the offboard is complete and idempotent.
    await this.#deactivate(principal, 'scim.user.delete');
  }

  // --- internals ------------------------------------------------------------

  /**
   * Deactivate a principal's credentials: revoke every live API key it holds.
   *
   * This is the offboarding security guarantee. Setting `principal.disabled`
   * alone already makes the auth middleware reject the next request, but
   * revoking the keys as well means the credentials are dead even if the
   * principal were ever re-enabled, and it is the honest record of "these tokens
   * no longer work". The revoke is a single bulk operation, not a
   * list-then-update loop, so it is not bounded by the store's page cap — a
   * principal with more than a page of live sessions is fully revoked, which is
   * the whole point. A failure is logged loudly and recorded as a non-allowed
   * audit outcome: a token that outlives an offboard is exactly what this exists
   * to prevent.
   */
  async #deactivate(principal: Principal, action: string): Promise<void> {
    const now = this.#clock.now();
    let revoked = 0;
    let outcome: 'allowed' | 'error' = 'allowed';
    try {
      revoked = await this.#store.apiKeys.revokeAllForPrincipal(principal.id, now);
    } catch (error) {
      // The disable write below still rejects the principal on the next request,
      // but an un-revoked key would spring back if the principal were ever
      // re-enabled, so a revocation failure is a real, loud problem.
      outcome = 'error';
      this.#logger?.error('scim deactivate: failed to revoke keys for principal', {
        principalId: principal.id,
        error,
      });
    }
    // Mark the disable as SCIM-originated ONLY when this deactivate is what
    // disabled the principal. If it was already disabled — e.g. an admin
    // deliberately disabled it outside SCIM — stamping the marker now would let a
    // later SCIM create/activate clear that admin decision (the reactivation path
    // trusts the marker to mean "SCIM disabled this"). Keys are revoked
    // unconditionally above so a delete is still idempotent; only the ownership
    // marker is conditional, mirroring the guard the PATCH/PUT paths already use.
    const patch: Partial<Principal> = { disabled: true, updatedAt: now };
    if (!principal.disabled) {
      patch.metadata = {
        ...(principal.metadata as Record<string, string>),
        'scim:deactivatedAt': String(now),
      };
    }
    await this.#store.principals.update(principal.id, patch);
    await this.#audit(action, principal, outcome, { deactivated: true, keysRevoked: revoked });
  }

  /** Whether a principal's current disabled state was set by a SCIM deactivate. */
  #scimDeactivated(principal: Principal): boolean {
    const metadata = principal.metadata as Record<string, string>;
    return typeof metadata['scim:deactivatedAt'] === 'string';
  }

  /** The principal's metadata with the SCIM-deactivation marker removed. */
  #clearDeactivated(principal: Principal): Record<string, string> {
    const metadata = { ...(principal.metadata as Record<string, string>) };
    delete metadata['scim:deactivatedAt'];
    return metadata;
  }

  /**
   * Re-revoke every API key on reactivation, defense-in-depth against a stale key
   * surviving a failed offboarding revoke.
   *
   * `#deactivate` is fail-open: if `revokeAllForPrincipal` throws (a transient DB
   * error) it still disables the principal and stamps the marker, so a key can
   * survive the revoke and be fenced only by `disabled=true`. Reactivation flips
   * `disabled=false`, so without this the survivor would authenticate again — the
   * exact "credentials are dead even if re-enabled" invariant this module
   * promises. Reactivation already means "a fresh set of keys is minted at next
   * login", so revoking here costs a legitimate rehire nothing and closes the
   * resurrection. Called at every reactivation branch (create/replace/patch).
   */
  async #revokeKeysOnReactivation(principalId: string): Promise<void> {
    await this.#store.apiKeys.revokeAllForPrincipal(principalId, this.#clock.now());
  }

  #subject(externalId: string): string {
    // #providerId is guaranteed present once `authorize` has run (every route
    // authorises first); assert to be safe against a misuse.
    if (!this.#providerId) {
      throw new ScimError(500, 'SCIM provider is not configured');
    }
    return federatedSubject(this.#providerId, externalId);
  }

  #belongsToProvider(principal: Principal): boolean {
    return this.#providerId !== undefined && principal.subject.startsWith(`oidc:${this.#providerId}:`);
  }

  #externalIdOf(principal: Principal): string {
    // Prefer the stored SCIM externalId; fall back to the tail of the subject.
    const metadata = principal.metadata as Record<string, string>;
    const stored = metadata['scim:externalId'];
    if (typeof stored === 'string' && stored.length > 0) return stored;
    const prefix = `oidc:${this.#providerId}:`;
    return principal.subject.startsWith(prefix) ? principal.subject.slice(prefix.length) : principal.subject;
  }

  #userNameOf(principal: Principal): string {
    // The stored login name; fall back to the externalId when a principal was
    // created by OIDC login (which stores no userName) rather than SCIM.
    const metadata = principal.metadata as Record<string, string>;
    const stored = metadata['scim:userName'];
    if (typeof stored === 'string' && stored.length > 0) return stored;
    return principal.email || this.#externalIdOf(principal);
  }

  /**
   * Find this provider's principals whose SCIM userName matches, by a bounded
   * scan. userName lives in metadata, which the repository cannot query, so a
   * scan is unavoidable — but an IdP's pre-create probe asks for one userName, so
   * it is bounded to maxPage pages and stops at the first page that satisfies it.
   */
  async #findByUserName(userName: string): Promise<Principal[]> {
    const found: Principal[] = [];
    let cursor: string | undefined;
    // A hard page ceiling so a hostile or huge directory cannot turn a probe into
    // an unbounded scan.
    for (let pages = 0; pages < 20; pages++) {
      const page = await this.#store.principals.list({
        limit: this.#maxPage,
        ...(cursor ? { cursor } : {}),
      });
      for (const principal of page.items) {
        // Match strictly on the SCIM-stored userName, never the email fallback
        // `#userNameOf` uses for display: email is neither unique nor the
        // convergence key, so matching it could bind the IdP's user to the wrong
        // principal and then operate PATCH/DELETE on the wrong person.
        const metadata = principal.metadata as Record<string, string>;
        if (this.#belongsToProvider(principal) && metadata['scim:userName'] === userName) {
          found.push(principal);
        }
      }
      if (found.length > 0 || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return found;
  }

  async #requirePrincipal(id: string): Promise<Principal> {
    const principal = await this.#store.principals.get(id);
    if (!principal || !this.#belongsToProvider(principal)) {
      // A principal from another provider (or none) is not ours to manage, and is
      // reported as not-found rather than leaking its existence.
      throw new ScimError(404, `User ${id} not found`);
    }
    return principal;
  }

  #toScim(principal: Principal): ScimUser {
    return {
      schemas: [USER_SCHEMA],
      id: principal.id,
      externalId: this.#externalIdOf(principal),
      userName: this.#userNameOf(principal),
      active: !principal.disabled,
      ...(principal.displayName ? { displayName: principal.displayName } : {}),
      ...(principal.email ? { emails: [{ value: principal.email, primary: true }] } : {}),
      meta: {
        resourceType: 'User',
        created: new Date(principal.createdAt).toISOString(),
        lastModified: new Date(principal.updatedAt).toISOString(),
        location: `/scim/v2/Users/${principal.id}`,
      },
    };
  }

  #listResponse(
    resources: ScimUser[],
    startIndex = 1,
    totalResults?: number,
  ): {
    schemas: string[];
    totalResults: number;
    startIndex: number;
    itemsPerPage: number;
    Resources: ScimUser[];
  } {
    return {
      schemas: [LIST_SCHEMA],
      // `totalResults` is the full count of matching users across all pages, NOT
      // the page length: a spec-compliant IdP pages until it has seen
      // `totalResults` resources, so reporting the page size makes a full sync of
      // more than one page stop after the first. `itemsPerPage` is the page length.
      // The single-match filter paths pass no explicit total (0 or 1 fits both).
      totalResults: totalResults ?? resources.length,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  }

  // --- payload parsing (untrusted IdP input) --------------------------------

  #parseUser(payload: unknown): {
    userName?: string;
    externalId?: string;
    displayName?: string;
    email?: string;
    active?: boolean;
  } {
    if (typeof payload !== 'object' || payload === null) {
      throw new ScimError(400, 'The request body must be a SCIM User object', 'invalidValue');
    }
    const p = payload as Record<string, unknown>;
    const userName = typeof p.userName === 'string' ? p.userName : undefined;
    const externalId = typeof p.externalId === 'string' ? p.externalId : undefined;
    const displayName =
      typeof p.displayName === 'string'
        ? p.displayName
        : this.#formattedName(p.name);
    const email = this.#primaryEmail(p.emails);
    // `active` is optional on create (defaults active); explicit false is
    // honoured. Some IdPs send it as the string "false"/"true" (Azure AD, in
    // particular, on a PUT), so normalise both forms — a string "false" that was
    // silently ignored would be an offboarding miss.
    const active = this.#normalizeActive(p.active);
    return {
      ...(userName ? { userName } : {}),
      ...(externalId ? { externalId } : {}),
      ...(displayName ? { displayName } : {}),
      ...(email ? { email } : {}),
      ...(active !== undefined ? { active } : {}),
    };
  }

  /** Normalise a SCIM `active` value: boolean, or the string "true"/"false". */
  #normalizeActive(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
    }
    return undefined;
  }

  #formattedName(name: unknown): string | undefined {
    if (typeof name !== 'object' || name === null) return undefined;
    const n = name as Record<string, unknown>;
    if (typeof n.formatted === 'string') return n.formatted;
    const given = typeof n.givenName === 'string' ? n.givenName : '';
    const family = typeof n.familyName === 'string' ? n.familyName : '';
    const joined = `${given} ${family}`.trim();
    return joined.length > 0 ? joined : undefined;
  }

  #primaryEmail(emails: unknown): string | undefined {
    if (!Array.isArray(emails)) return undefined;
    const entries = emails.filter(
      (entry): entry is { value: string; primary?: boolean } =>
        typeof entry === 'object' && entry !== null && typeof (entry as { value?: unknown }).value === 'string',
    );
    if (entries.length === 0) return undefined;
    return (entries.find((entry) => entry.primary) ?? entries[0]!).value;
  }

  #parsePatch(payload: unknown): { op?: string; path?: string; value?: unknown }[] {
    if (typeof payload !== 'object' || payload === null) {
      throw new ScimError(400, 'The request body must be a SCIM PatchOp', 'invalidValue');
    }
    const p = payload as Record<string, unknown>;
    const schemas = Array.isArray(p.schemas) ? p.schemas : [];
    if (!schemas.includes(PATCH_SCHEMA)) {
      throw new ScimError(400, 'A PATCH body must use the PatchOp schema', 'invalidValue');
    }
    if (!Array.isArray(p.Operations)) {
      throw new ScimError(400, 'A PatchOp must carry an Operations array', 'invalidValue');
    }
    return p.Operations.filter(
      (op): op is { op?: string; path?: string; value?: unknown } => typeof op === 'object' && op !== null,
    );
  }

  /** Extract `active` from a patch op value, handling both `path:active` and a bare object. */
  #activeFromPatchValue(path: string, value: unknown): boolean | undefined {
    if (path === 'active') {
      if (typeof value === 'boolean') return value;
      // Some IdPs send the string "False"/"True".
      if (typeof value === 'string') return value.toLowerCase() === 'true';
      return undefined;
    }
    // Bare object form: { value: { active: false } }
    if (typeof value === 'object' && value !== null && 'active' in value) {
      const active = (value as { active: unknown }).active;
      if (typeof active === 'boolean') return active;
      if (typeof active === 'string') return active.toLowerCase() === 'true';
    }
    return undefined;
  }

  #parseEqFilter(filter: string): { attribute: string; value: string } {
    // SCIM filters we support: `userName eq "x"` and `externalId eq "x"`.
    // Anything else is refused, because returning an unfiltered list to an IdP
    // that asked a question we did not answer reads as "no match" and causes a
    // duplicate create.
    const match = /^\s*(userName|externalId)\s+eq\s+"([^"]*)"\s*$/i.exec(filter);
    if (!match) {
      throw new ScimError(400, `Unsupported filter: ${filter}`, 'invalidFilter');
    }
    return { attribute: match[1]!, value: match[2]! };
  }

  async #audit(
    action: string,
    principal: Principal,
    outcome: 'allowed' | 'denied' | 'error',
    details: Record<string, unknown>,
  ): Promise<void> {
    const now = this.#clock.now();
    try {
      await this.#store.audit.append({
        id: newId('auditEntry', now),
        principalId: 'scim',
        action,
        resourceKind: 'principal',
        resourceId: principal.id,
        outcome,
        reason: '',
        requestId: '',
        sourceIp: '',
        details,
        at: now,
      });
    } catch (error) {
      // An audit write must never fail the provisioning operation, but a dropped
      // security record is worth a loud log.
      this.#logger?.error('failed to write a SCIM audit entry', { action, error });
    }
  }
}
