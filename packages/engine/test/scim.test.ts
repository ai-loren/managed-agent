/**
 * SCIM 2.0 provisioning tests.
 *
 * The two claims that matter and are easy to get wrong: a SCIM-provisioned user
 * and a later OIDC login of the same person resolve to *one* principal
 * (convergence), and a SCIM deactivate *revokes that principal's live tokens*
 * (the offboarding guarantee). Both are asserted against the real store, plus the
 * full surface of create/get/list/patch/put/delete and the auth guard.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, TestClock, hashToken, newId, nullLogger, randomToken } from '@ma/core';
import { createMemoryStore, type SqliteStore } from '@ma/store';

import { ScimService, ScimError, federatedSubject } from '../src/index.ts';

const START = 1_700_000_000_000;
const PROVIDER = 'okta';
const TOKEN = 'scim-secret-token-of-adequate-length';

let store: SqliteStore;
let clock: TestClock;

function makeService(overrides: { token?: string; providerId?: string; maxPageSize?: number } = {}): ScimService {
  return new ScimService({
    clock,
    store,
    logger: nullLogger,
    token: 'token' in overrides ? overrides.token : TOKEN,
    providerId: 'providerId' in overrides ? overrides.providerId : PROVIDER,
    ...(overrides.maxPageSize !== undefined ? { maxPageSize: overrides.maxPageSize } : {}),
  });
}

function userPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: 'alice@corp.example',
    externalId: 'ext-alice',
    name: { givenName: 'Alice', familyName: 'Smith' },
    emails: [{ value: 'alice@corp.example', primary: true }],
    active: true,
    ...overrides,
  };
}

/** Mint a live API key for a principal, returning the plaintext token. */
async function mintKey(principalId: string): Promise<string> {
  const token = randomToken(32);
  await store.apiKeys.create({
    id: newId('apiKey', START),
    principalId,
    name: 'sso session',
    prefix: token.slice(0, 8),
    tokenHash: hashToken(token),
    scopes: ['ma:*'],
    createdAt: START,
    updatedAt: START,
    createdBy: 'sso',
  });
  return token;
}

beforeEach(() => {
  store = createMemoryStore();
  clock = new TestClock(START);
});

describe('SCIM auth', () => {
  test('refuses a request with no token, a wrong token, and when disabled', () => {
    const service = makeService();
    assert.throws(() => service.authorize(undefined), (e: unknown) => e instanceof ScimError && e.status === 401);
    assert.throws(() => service.authorize('wrong'), (e: unknown) => e instanceof ScimError && e.status === 401);

    const disabled = makeService({ token: undefined });
    assert.equal(disabled.enabled, false);
    // A disabled service reports the same 401 as a wrong token — no oracle.
    assert.throws(() => disabled.authorize(TOKEN), (e: unknown) => e instanceof ScimError && e.status === 401);
  });

  test('accepts the correct token', () => {
    const service = makeService();
    assert.equal(service.enabled, true);
    service.authorize(TOKEN); // does not throw
  });
});

describe('SCIM provisioning', () => {
  test('creates a principal in the OIDC subject space (convergence)', async () => {
    const service = makeService();
    const { user, created } = await service.createUser(userPayload());
    assert.equal(created, true);
    assert.equal(user.active, true);
    assert.equal(user.userName, 'alice@corp.example');

    // The stored principal uses the SAME subject a later OIDC login would match.
    const expectedSubject = federatedSubject(PROVIDER, 'ext-alice');
    const principal = await store.principals.getBySubject(expectedSubject);
    assert.ok(principal, 'the principal must live at the OIDC-convergent subject');
    assert.equal(principal.id, user.id);
    assert.equal(principal.email, 'alice@corp.example');
    assert.equal(principal.displayName, 'Alice Smith');
    assert.equal(principal.isAdmin, false, 'SCIM never grants admin');
    assert.equal(principal.createdBy, 'scim');
  });

  test('create is idempotent on externalId (no duplicate on retry)', async () => {
    const service = makeService();
    const first = await service.createUser(userPayload());
    const second = await service.createUser(userPayload({ name: { formatted: 'Alice S.' } }));
    assert.equal(second.created, false, 'a repeated create converges, not duplicates');
    assert.equal(second.user.id, first.user.id);

    const all = await store.principals.list({ limit: 100 });
    assert.equal(all.items.length, 1, 'exactly one principal exists');
  });

  test('refuses a create with no externalId (convergence key is mandatory)', async () => {
    // Falling back to userName as the key would silently key the principal on an
    // email rather than the OIDC `sub`, so a later login would land on a second
    // principal and an offboard would revoke the wrong one's tokens. Refuse.
    const service = makeService();
    await assert.rejects(
      service.createUser(userPayload({ externalId: undefined })),
      (e: unknown) => e instanceof ScimError && e.status === 400,
    );
    const all = await store.principals.list({ limit: 10 });
    assert.equal(all.items.length, 0, 'no principal is created without a convergence key');
  });

  test('a filtered list returns a match an IdP probes for before create', async () => {
    const service = makeService();
    await service.createUser(userPayload());

    // Okta-style: probe by userName before creating.
    const byUserName = await service.listUsers(
      new URLSearchParams({ filter: 'userName eq "alice@corp.example"' }),
    );
    assert.equal(byUserName.totalResults, 1);
    assert.equal(byUserName.Resources[0]!.externalId, 'ext-alice');

    // Azure-style: probe by externalId (the indexed subject key).
    const byExternalId = await service.listUsers(
      new URLSearchParams({ filter: 'externalId eq "ext-alice"' }),
    );
    assert.equal(byExternalId.totalResults, 1);
    assert.equal(byExternalId.Resources[0]!.userName, 'alice@corp.example');
  });

  test('a filter with no match returns an empty list (so the IdP creates)', async () => {
    const service = makeService();
    const list = await service.listUsers(new URLSearchParams({ filter: 'userName eq "nobody"' }));
    assert.equal(list.totalResults, 0);
    assert.deepEqual(list.Resources, []);
  });

  test('an unsupported filter is refused rather than returning everything', async () => {
    // Returning an unfiltered list to a query we did not answer reads as "no
    // match" to the IdP and causes a duplicate create.
    const service = makeService();
    await assert.rejects(
      service.listUsers(new URLSearchParams({ filter: 'displayName sw "A"' })),
      (e: unknown) => e instanceof ScimError && e.status === 400,
    );
  });

  test('a no-filter list reports the full provider total, not just the page size', async () => {
    // A spec-compliant IdP pages until it has seen `totalResults` resources. If
    // totalResults equalled the page length, a full sync of more than one page
    // would stop after the first — silently dropping every later user.
    const service = makeService({ maxPageSize: 2 });
    for (let i = 0; i < 5; i++) {
      await service.createUser(userPayload({ userName: `u${i}@corp.example`, externalId: `ext-u${i}` }));
    }

    const page = await service.listUsers(new URLSearchParams({ startIndex: '1', count: '2' }));
    assert.equal(page.itemsPerPage, 2, 'the page holds the requested count');
    assert.equal(page.Resources.length, 2, 'two resources on the first page');
    assert.equal(page.totalResults, 5, 'totalResults is the full provider count, not the page size');
    // The IdP can page to the rest using the reported total.
    const rest = await service.listUsers(new URLSearchParams({ startIndex: '3', count: '2' }));
    assert.equal(rest.totalResults, 5);
    assert.equal(rest.startIndex, 3);
    assert.ok(rest.Resources.length >= 1, 'later pages are reachable');
  });

  test('count=0 returns zero resources but still the full total (the RFC probe)', async () => {
    // RFC 7644 §3.4.2.4: an IdP may send count=0 as a cheap probe for totalResults
    // without transferring any resources. `Number('0') || maxPage` swallows the
    // zero and returns a whole page, so the probe transfers a full page it never
    // asked for. count must be honoured as zero: no resources, but totalResults
    // still populated so the IdP learns the directory size.
    const service = makeService({ maxPageSize: 2 });
    for (let i = 0; i < 5; i++) {
      await service.createUser(userPayload({ userName: `p${i}@corp.example`, externalId: `ext-p${i}` }));
    }

    const probe = await service.listUsers(new URLSearchParams({ count: '0' }));
    assert.equal(probe.Resources.length, 0, 'count=0 returns no resources');
    assert.equal(probe.itemsPerPage, 0, 'itemsPerPage reflects the empty page');
    assert.equal(probe.totalResults, 5, 'totalResults still reports the full provider count');
  });
});

describe('SCIM deactivation — the offboarding guarantee', () => {
  test('PATCH active:false disables the principal AND revokes its live tokens', async () => {
    const service = makeService();
    const { user } = await service.createUser(userPayload());
    const token = await mintKey(user.id);

    // The token is live before deactivation.
    assert.ok(await store.apiKeys.getByHash(hashToken(token)));
    const before = await store.apiKeys.getByHash(hashToken(token));
    assert.equal(before!.revokedAt, undefined);

    const patched = await service.patchUser(user.id, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    assert.equal(patched.active, false);

    // The principal is disabled...
    const principal = await store.principals.get(user.id);
    assert.equal(principal!.disabled, true);
    // ...and the key is revoked — the offboarding guarantee. Without token
    // revocation, a fired employee's session would live until it expired.
    const after = await store.apiKeys.getByHash(hashToken(token));
    assert.equal(typeof after!.revokedAt, 'number', 'the live token must be revoked on deactivate');
  });

  test('DELETE deactivates and revokes, but preserves the principal row', async () => {
    const service = makeService();
    const { user } = await service.createUser(userPayload());
    const token = await mintKey(user.id);

    await service.deleteUser(user.id);

    const principal = await store.principals.get(user.id);
    assert.ok(principal, 'the principal row is preserved (audit history, memberships)');
    assert.equal(principal.disabled, true);
    const key = await store.apiKeys.getByHash(hashToken(token));
    assert.equal(typeof key!.revokedAt, 'number', 'delete revokes tokens too');
  });

  test('PUT with active:false deactivates', async () => {
    const service = makeService();
    const { user } = await service.createUser(userPayload());
    const token = await mintKey(user.id);
    await service.replaceUser(user.id, userPayload({ active: false }));

    const key = await store.apiKeys.getByHash(hashToken(token));
    assert.equal(typeof key!.revokedAt, 'number');
  });

  test('reactivation re-enables a previously deactivated principal', async () => {
    const service = makeService();
    const { user } = await service.createUser(userPayload());
    await service.patchUser(user.id, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    assert.equal((await store.principals.get(user.id))!.disabled, true);

    // A re-provision (create) of the same externalId reactivates.
    const again = await service.createUser(userPayload());
    assert.equal(again.created, false);
    assert.equal((await store.principals.get(user.id))!.disabled, false);
  });

  test('a user created inactive can later be activated (create-inactive is SCIM-owned)', async () => {
    // A future-hire provisioned active:false must be enable-able through SCIM.
    // Reactivation is gated on the SCIM-deactivation marker (so an admin's
    // deliberate disable is never cleared); a create-inactive user that carried
    // no marker was misclassified as an admin disable and could never be enabled.
    const service = makeService();
    const created = await service.createUser(userPayload({ active: false }));
    assert.equal(created.user.active, false, 'created inactive');
    assert.equal((await store.principals.get(created.user.id))!.disabled, true);

    // A later activate (via create with active:true, as an IdP re-provisions) works.
    const activated = await service.createUser(userPayload({ active: true }));
    assert.equal(activated.user.active, true, 'a create-inactive user can be activated by SCIM');
    assert.equal((await store.principals.get(created.user.id))!.disabled, false);
  });

  test('never clears an admin’s deliberate disable', async () => {
    // A principal disabled by an admin (not by SCIM) must NOT be re-enabled by a
    // routine IdP sync — otherwise SCIM would silently undo a security action.
    const service = makeService();
    const { user } = await service.createUser(userPayload());
    // Admin disables directly, with no SCIM-deactivation marker.
    await store.principals.update(user.id, { disabled: true });

    // A create and a PATCH active:true both leave the admin disable intact.
    const again = await service.createUser(userPayload());
    assert.equal(again.user.active, false, 'a SCIM create must not clear an admin disable');
    assert.equal((await store.principals.get(user.id))!.disabled, true);

    const patched = await service.patchUser(user.id, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: true }],
    });
    assert.equal(patched.active, false, 'a SCIM activate must not clear an admin disable');
    assert.equal((await store.principals.get(user.id))!.disabled, true);
  });

  test('a SCIM DELETE on an admin-disabled principal does not let a later create re-enable it', async () => {
    // The gap the create/PATCH guard did not cover: deleteUser → #deactivate used
    // to stamp the scim:deactivatedAt marker UNCONDITIONALLY, even on a principal
    // an admin had already disabled. A later SCIM re-provision then read that
    // marker as "SCIM disabled this" and cleared the admin's decision. The DELETE
    // must not stamp the marker when the principal was already disabled.
    const service = makeService();
    const { user } = await service.createUser(userPayload());
    // Admin disables directly (no SCIM marker), then SCIM offboards via DELETE.
    await store.principals.update(user.id, { disabled: true });
    await service.deleteUser(user.id);

    // The marker must not have been stamped by the delete.
    const afterDelete = await store.principals.get(user.id);
    assert.equal(afterDelete!.disabled, true);
    assert.equal(
      (afterDelete!.metadata as Record<string, string>)['scim:deactivatedAt'],
      undefined,
      'the DELETE must not claim SCIM ownership of an admin disable',
    );

    // A re-provision must therefore leave the admin disable intact.
    const again = await service.createUser(userPayload());
    assert.equal(again.user.active, false, 'a re-provision must not clear the admin disable');
    assert.equal((await store.principals.get(user.id))!.disabled, true);
  });

  test('honours a string "false" active on PATCH and PUT (offboard not missed)', async () => {
    const service = makeService();

    // PATCH with the string form some IdPs send.
    const a = await service.createUser(userPayload());
    const tokenA = await mintKey(a.user.id);
    await service.patchUser(a.user.id, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: 'False' }],
    });
    assert.equal((await store.principals.get(a.user.id))!.disabled, true);
    assert.equal(typeof (await store.apiKeys.getByHash(hashToken(tokenA)))!.revokedAt, 'number');

    // PUT with a string active:"false" (Azure AD style).
    const b = await service.createUser(userPayload({ externalId: 'ext-bob', userName: 'bob@corp.example' }));
    const tokenB = await mintKey(b.user.id);
    await service.replaceUser(b.user.id, userPayload({
      externalId: 'ext-bob',
      userName: 'bob@corp.example',
      active: 'false',
    }));
    assert.equal((await store.principals.get(b.user.id))!.disabled, true);
    assert.equal(typeof (await store.apiKeys.getByHash(hashToken(tokenB)))!.revokedAt, 'number');
  });

  test('revokes more live tokens than a single store page holds', async () => {
    // The offboarding sweep must not be bounded by the store's page cap. Mint a
    // pile of keys and confirm every one is revoked on deactivate.
    const service = makeService();
    const { user } = await service.createUser(userPayload());
    const tokens: string[] = [];
    for (let i = 0; i < 250; i++) tokens.push(await mintKey(user.id));

    await service.deleteUser(user.id);

    for (const token of tokens) {
      const key = await store.apiKeys.getByHash(hashToken(token));
      assert.equal(typeof key!.revokedAt, 'number', 'every key must be revoked, beyond one page');
    }
  });
});

describe('SCIM isolation between providers', () => {
  test('cannot read or manage a principal from another provider', async () => {
    // A principal provisioned under a different provider is not this SCIM
    // connector's to see — reported as 404, not leaked.
    const other = await store.principals.create({
      id: newId('principal', START),
      type: 'user',
      subject: federatedSubject('auth0', 'someone'),
      displayName: 'Other',
      email: '',
      isAdmin: false,
      disabled: false,
      metadata: {},
      createdAt: START,
      updatedAt: START,
      createdBy: 'sso',
    });

    const service = makeService(); // providerId = okta
    await assert.rejects(
      service.getUser(other.id),
      (e: unknown) => e instanceof ScimError && e.status === 404,
    );
    await assert.rejects(
      service.deleteUser(other.id),
      (e: unknown) => e instanceof ScimError && e.status === 404,
    );
  });

  test('a list omits principals from other providers', async () => {
    await store.principals.create({
      id: newId('principal', START),
      type: 'user',
      subject: federatedSubject('auth0', 'someone'),
      displayName: 'Other',
      email: '',
      isAdmin: false,
      disabled: false,
      metadata: {},
      createdAt: START,
      updatedAt: START,
      createdBy: 'sso',
    });
    const service = makeService();
    await service.createUser(userPayload());

    const list = await service.listUsers(new URLSearchParams());
    assert.equal(list.totalResults, 1, 'only this provider’s users appear');
    assert.equal(list.Resources[0]!.externalId, 'ext-alice');
    assert.equal(list.Resources[0]!.userName, 'alice@corp.example');
  });

  test('a full list pages past other providers’ users instead of losing its own', async () => {
    // The bug: listUsers fetched a single page-capped batch and only THEN filtered
    // by provider, so other providers' principals occupying that page could push
    // this provider's users off it entirely — invisible to a full sync. Seed more
    // foreign principals than the page cap, created BEFORE this provider's users
    // (so they sort first by id), then confirm the list still finds ours by paging.
    let ts = START;
    for (let i = 0; i < 5; i++) {
      await store.principals.create({
        id: newId('principal', ts++),
        type: 'user',
        subject: federatedSubject('auth0', `foreign-${i}`),
        displayName: `Foreign ${i}`,
        email: '',
        isAdmin: false,
        disabled: false,
        metadata: {},
        createdAt: ts,
        updatedAt: ts,
        createdBy: 'sso',
      });
    }
    // Page cap of 2 < the 5 foreign principals: a single capped fetch would return
    // only foreign users and this provider's would never appear.
    const service = makeService({ maxPageSize: 2 });
    await service.createUser(userPayload());
    await service.createUser(userPayload({ userName: 'bob@corp.example', externalId: 'ext-bob' }));

    const list = await service.listUsers(new URLSearchParams());
    const ids = list.Resources.map((r) => r.externalId).sort();
    assert.deepEqual(ids, ['ext-alice', 'ext-bob'], 'both of this provider’s users are found past the foreign page');

    // startIndex pages within this provider's own users.
    const second = await service.listUsers(new URLSearchParams({ startIndex: '2', count: '1' }));
    assert.equal(second.startIndex, 2, 'the response echoes the requested startIndex');
    assert.equal(second.Resources.length, 1, 'one user on the second page');
  });
});

describe('SCIM payload validation', () => {
  test('rejects a create with neither userName nor externalId', async () => {
    const service = makeService();
    await assert.rejects(
      service.createUser({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], active: true }),
      (e: unknown) => e instanceof ScimError && e.status === 400,
    );
  });

  test('rejects a non-object body', async () => {
    const service = makeService();
    await assert.rejects(service.createUser('not an object'), (e: unknown) => e instanceof ScimError);
  });

  test('rejects a PATCH without the PatchOp schema', async () => {
    const service = makeService();
    const { user } = await service.createUser(userPayload());
    await assert.rejects(
      service.patchUser(user.id, { Operations: [{ op: 'replace', path: 'active', value: false }] }),
      (e: unknown) => e instanceof ScimError && e.status === 400,
    );
  });

  test('honours an inactive create (provisioned but cannot log in yet)', async () => {
    const service = makeService();
    const { user } = await service.createUser(userPayload({ active: false }));
    assert.equal(user.active, false);
    assert.equal((await store.principals.get(user.id))!.disabled, true);
  });
});
