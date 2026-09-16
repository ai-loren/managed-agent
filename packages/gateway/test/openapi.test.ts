/**
 * OpenAPI tests.
 *
 * The document is generated from the same schemas the gateway validates
 * against, so most of its content is verified by construction. What these tests
 * check is the part that could still be wrong: that it is structurally valid,
 * that nothing dangles, and that the security-relevant statements it makes are
 * true of the implementation.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, TestClock, nullLogger } from '@ma/core';
import { createMemoryStore } from '@ma/store';
import {
  AgentService,
  ArtifactService,
  MemoryBlobStore,
  MemoryService,
  TemplateService,
  PreviewService,
  CredentialService,
  EventBus,
  QuotaService,
  RoleAuthorizer,
  SessionService,
  WorkspaceService,
} from '@ma/engine';

import {
  Gateway,
  SseBridge,
  buildOpenApi,
  registerIntegrationRoutes,
} from '../src/index.ts';
import {
  bindDatasetsBody,
  connectorStatusBody,
  createAgentBody,
  createConnectorBody,
  createCredentialBody,
  createDatasetBody,
  createDocumentBody,
  createMemoryBody,
  createSessionBody,
  createTemplateBody,
  createVersionBody,
  createWorkspaceBody,
  instantiateTemplateBody,
  grantResourceRoleBody,
  membersBody,
  updateQuotaBody,
  promoteMemoryBody,
  reasonBody,
  renewSessionBody,
  updateAgentBody,
  updateConnectorBody,
  updateMemoryBody,
  updateTemplateBody,
  updateWorkspaceBody,
} from '../src/request-schemas.ts';

interface Document {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  security: unknown[];
  tags: { name: string }[];
  components: {
    schemas: Record<string, Record<string, unknown>>;
    securitySchemes: Record<string, unknown>;
    responses: Record<string, unknown>;
  };
  paths: Record<string, Record<string, Record<string, unknown>>>;
}

let doc: Document;

before(() => {
  doc = buildOpenApi({ version: '1.2.3' }) as unknown as Document;
});

describe('document structure', () => {
  test('declares a supported OpenAPI version and its own', () => {
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(doc.info.version, '1.2.3');
  });

  test('every $ref resolves', () => {
    // A dangling ref breaks client generators in ways that are tedious to
    // diagnose from the generated output.
    const json = JSON.stringify(doc);
    const refs = [...json.matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];

    assert.ok(refs.length > 50, 'the document should actually use components');
    const dangling = refs.filter(
      ([, kind, name]) =>
        !(doc.components as unknown as Record<string, Record<string, unknown>>)[kind!]?.[name!],
    );
    assert.deepEqual(dangling.map((match) => match[0]), []);
  });

  test('exposes the entity schemas a client needs', () => {
    for (const name of [
      'Workspace',
      'Agent',
      'AgentVersion',
      'Session',
      'SessionEvent',
      'UniversalEvent',
      'Credential',
      'Connector',
      'Receipt',
      'Dataset',
      'Error',
    ]) {
      assert.ok(doc.components.schemas[name], `${name} must be a reusable component`);
    }
  });

  test('every operation declares its responses and a tag', () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        assert.ok(operation.responses, `${method.toUpperCase()} ${path} has no responses`);
        assert.ok(operation.summary, `${method.toUpperCase()} ${path} has no summary`);
        assert.ok(operation.tags, `${method.toUpperCase()} ${path} has no tag`);
      }
    }
  });

  test('every tag used is declared', () => {
    const declared = new Set(doc.tags.map((tag) => tag.name));
    for (const methods of Object.values(doc.paths)) {
      for (const operation of Object.values(methods)) {
        for (const tag of (operation.tags as string[] | undefined) ?? []) {
          assert.ok(declared.has(tag), `tag '${tag}' is used but not declared`);
        }
      }
    }
  });
});

describe('security', () => {
  test('requires a bearer token by default', () => {
    assert.deepEqual(doc.security, [{ bearerAuth: [] }]);
    assert.ok(doc.components.securitySchemes.bearerAuth);
  });

  test('only the genuinely public endpoints opt out', () => {
    // Anything else opting out of auth would be a real hole, so the list is
    // asserted rather than merely spot-checked.
    const open: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const operation of Object.values(methods)) {
        if (Array.isArray(operation.security) && operation.security.length === 0) {
          open.push(path);
        }
      }
    }

    assert.deepEqual(
      open.sort(),
      [
        '/health',
        '/ingress/v1/{workspaceId}/{externalKey}',
        '/preview/v1/{artifactId}',
      ],
      'health is unauthenticated; ingress and preview authenticate by signature instead',
    );
  });

  test('documents that inbound deliveries are signed', () => {
    const ingress = doc.paths['/ingress/v1/{workspaceId}/{externalKey}']!.post!;
    const parameters = (ingress.parameters as { name: string; required?: boolean }[]) ?? [];
    const signature = parameters.find((parameter) => parameter.name === 'X-MA-Signature');
    const timestamp = parameters.find((parameter) => parameter.name === 'X-MA-Timestamp');

    assert.ok(signature?.required, 'the signature is not optional');
    assert.ok(timestamp?.required, 'the timestamp is what bounds a replay');
  });

  test('never describes an endpoint that returns a credential value', () => {
    // The API's central security promise: values go in and never come out.
    const credentialPaths = Object.entries(doc.paths).filter(([path]) =>
      path.includes('credential'),
    );
    assert.ok(credentialPaths.length > 0);

    for (const [path, methods] of credentialPaths) {
      for (const [method, operation] of Object.entries(methods)) {
        const rendered = JSON.stringify(operation);
        assert.equal(
          /"value"\s*:\s*\{[^}]*"description"[^}]*"returns/i.test(rendered),
          false,
          `${method.toUpperCase()} ${path} must not advertise reading a value`,
        );
      }
    }
  });
});

describe('documented behaviour', () => {
  test('explains that retryable is authoritative, not the status code', () => {
    const error = doc.components.schemas.Error as {
      properties: { error: { properties: { retryable: { description: string } } } };
    };
    assert.ok(error.properties.error.properties.retryable.description.includes('status'));
  });

  test('explains idempotency, streaming resume and keyset pagination', () => {
    // These three are where a client integrating against this gets it wrong if
    // the document stays silent.
    const description = doc.info.description;
    assert.ok(description.includes('Idempotency-Key'));
    assert.ok(description.includes('Last-Event-ID'));
    assert.ok(description.toLowerCase().includes('keyset'));
  });

  test('marks the version diff on the publish response', () => {
    const publish = doc.paths['/v1/agents/{agentId}/versions']!.post!;
    const created = (publish.responses as Record<string, { content?: Record<string, { schema: { properties: Record<string, unknown> } }> }>)[
      '201'
    ];
    const schema = created?.content?.['application/json']?.schema;
    assert.ok(schema?.properties.diff, 'the diff is how an accidental drop becomes visible');
  });

  test('documents the streaming endpoint as an event stream', () => {
    const stream = doc.paths['/v1/sessions/{sessionId}/events/stream']!.get!;
    const ok = (stream.responses as Record<string, { content?: Record<string, unknown> }>)['200'];
    assert.ok(ok?.content?.['text/event-stream']);
  });

  test('covers the surfaces an operator needs', () => {
    for (const path of [
      '/v1/workspaces',
      '/v1/sessions',
      '/v1/sessions/{sessionId}/events',
      '/v1/sessions/{sessionId}/events/stream',
      '/v1/agents/{agentId}/versions',
      '/v1/workspaces/{workspaceId}/quota',
      '/v1/connectors/{connectorId}/receipts',
      '/v1/connectors/{connectorId}/next-fire',
      '/v1/datasets/{datasetId}/documents',
    ]) {
      assert.ok(doc.paths[path], `${path} is missing from the specification`);
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * The routes a real gateway registers.
 *
 * Built with stub dependencies: route *registration* does not touch them, and
 * this test is about which paths exist, not what they do.
 */
function registeredRoutes(): readonly { method: string; pattern: string }[] {
  const store = createMemoryStore();
  const clock = new TestClock(1_700_000_000_000);
  const deps = { store, clock, logger: nullLogger, authorizer: new RoleAuthorizer() };
  const quota = new QuotaService(store, clock);
  const bus = new EventBus(store, clock, nullLogger);

  const gateway = new Gateway({
    store,
    clock,
    logger: nullLogger,
    authorizer: new RoleAuthorizer(),
    quota,
    workspaces: new WorkspaceService({ ...deps, quota }),
    agents: new AgentService({ ...deps, quota }),
    sessions: new SessionService({ ...deps, quota, bus }),
    credentials: new CredentialService({ ...deps, quota, keys: InMemoryKeyProvider.generate() }),
    artifacts: new ArtifactService({ ...deps, quota, blobs: new MemoryBlobStore() }),
    memories: new MemoryService({ ...deps, quota }),
    templates: new TemplateService({ ...deps, quota }),
    previews: new PreviewService({ clock, keys: InMemoryKeyProvider.generate(), previewOrigin: 'https://artifacts.test', consoleOrigin: 'https://console.test' }),
    sse: new SseBridge({ bus, store, clock, logger: nullLogger }),
    version: '0.1.0-test',
  });

  registerIntegrationRoutes(gateway.router, {
    store,
    clock,
    workspaces: new WorkspaceService({ ...deps, quota }),
    authorize: () => Promise.resolve(),
    authorizeResource: () => Promise.resolve(),
    activate: () => Promise.resolve(undefined as never),
    rescheduleNext: () => Promise.resolve(undefined),
    retryReceipt: () => Promise.resolve(undefined as never),
    bindDatasets: () => Promise.resolve(undefined as never),
    deleteDataset: () => Promise.resolve(0),
  });

  const routes = [...gateway.router.registered];
  void store.close();
  return routes;
}

describe('coverage of the real router', () => {
  /**
   * Paths deliberately absent from the document, each with a reason.
   *
   * An exclusion has to be justified here rather than by silence, or the test
   * degrades into whatever the document happens to contain.
   */
  const EXCLUDED = new Map<string, string>([
    ['GET /', 'the console, an HTML page rather than an API operation'],
    ['GET /health', 'unauthenticated liveness probe, not part of the tenant API'],
    ['GET /metrics', 'Prometheus scrape endpoint, its own token surface, not the tenant API'],
    ['GET /openapi.json', 'the document describing itself'],
  ]);

  /** Runtime, ingress, auth and SCIM authenticate differently and are not the tenant API. */
  function isSeparateSurface(pattern: string): boolean {
    return (
      pattern.startsWith('/runtime/') ||
      pattern.startsWith('/ingress/') ||
      pattern.startsWith('/auth/') ||
      pattern.startsWith('/scim/')
    );
  }

  test('every registered route appears in the document', () => {
    // The generator shares the gateway's *schemas*, which is what its docblock
    // is about — but its path list is a hand-written literal, and it had
    // silently drifted eleven routes behind the router. Anyone generating a
    // client from this document could not reach a quarter of the API, and the
    // comment told them there was nothing to check.
    const documented = new Set<string>();
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const method of Object.keys(operations as Record<string, unknown>)) {
        // OpenAPI writes `{id}` where the router writes `:id`.
        documented.add(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`);
      }
    }

    const missing: string[] = [];
    for (const { method, pattern } of registeredRoutes()) {
      const key = `${method} ${pattern}`;
      if (EXCLUDED.has(key) || isSeparateSurface(pattern)) continue;
      if (!documented.has(key)) missing.push(key);
    }

    assert.deepEqual(missing, [], `undocumented routes: ${missing.join(', ')}`);
  });

  test('the document describes no route that does not exist', () => {
    // The other direction: a documented operation with no handler is a client
    // generated against a 404.
    const real = new Set(
      registeredRoutes().map(({ method, pattern }) => `${method} ${pattern}`),
    );

    const phantom: string[] = [];
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const method of Object.keys(operations as Record<string, unknown>)) {
        const pattern = path.replace(/\{(\w+)\}/g, ':$1');
        // Ingress is registered by the composition root rather than by the
        // gateway, so it is genuinely reachable even though this router does
        // not carry it. Documenting it is correct; asserting it here is not.
        if (isSeparateSurface(pattern)) continue;
        const key = `${method.toUpperCase()} ${pattern}`;
        if (!real.has(key)) phantom.push(key);
      }
    }

    assert.deepEqual(phantom, [], `documented but unroutable: ${phantom.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// Request-body drift
// ---------------------------------------------------------------------------

describe('request bodies match the parse schemas', () => {
  /**
   * Every documented body, mapped to the schema the handler actually parses
   * with. Both sides derive from the same constant now, so this is tautological
   * *when wired* — its whole value is that it fails the moment someone reverts a
   * `requestBody` in openapi.ts to a hand-written literal, or adds a
   * body-carrying route and forgets to back it with a shared schema. That is the
   * drift the generator's docblock claims cannot happen; before this, it could.
   */
  const EXPECTED: Record<string, { method: string; schema: { toJsonSchema(): unknown } }> = {
    'POST /v1/workspaces': { method: 'post', schema: createWorkspaceBody },
    'PATCH /v1/workspaces/{workspaceId}': { method: 'patch', schema: updateWorkspaceBody },
    'PUT /v1/workspaces/{workspaceId}/members': { method: 'put', schema: membersBody },
    'POST /v1/workspaces/{workspaceId}/grants': { method: 'post', schema: grantResourceRoleBody },
    'PUT /v1/workspaces/{workspaceId}/quota': { method: 'put', schema: updateQuotaBody },
    'POST /v1/workspaces/{workspaceId}/agents': { method: 'post', schema: createAgentBody },
    'PATCH /v1/agents/{agentId}': { method: 'patch', schema: updateAgentBody },
    'PUT /v1/agents/{agentId}/datasets': { method: 'put', schema: bindDatasetsBody },
    'POST /v1/agents/{agentId}/versions': { method: 'post', schema: createVersionBody },
    'POST /v1/sessions': { method: 'post', schema: createSessionBody },
    'POST /v1/sessions/{sessionId}/interrupt': { method: 'post', schema: reasonBody },
    'POST /v1/sessions/{sessionId}/terminate': { method: 'post', schema: reasonBody },
    'POST /v1/sessions/{sessionId}/renew': { method: 'post', schema: renewSessionBody },
    'POST /v1/workspaces/{workspaceId}/credentials': { method: 'post', schema: createCredentialBody },
    'POST /v1/workspaces/{workspaceId}/connectors': { method: 'post', schema: createConnectorBody },
    'PATCH /v1/connectors/{connectorId}': { method: 'patch', schema: updateConnectorBody },
    'POST /v1/connectors/{connectorId}/status': { method: 'post', schema: connectorStatusBody },
    'POST /v1/receipts/{receiptId}/retry': { method: 'post', schema: reasonBody },
    'POST /v1/workspaces/{workspaceId}/memories': { method: 'post', schema: createMemoryBody },
    'PATCH /v1/memories/{memoryId}': { method: 'patch', schema: updateMemoryBody },
    'POST /v1/memories/{memoryId}/promote': { method: 'post', schema: promoteMemoryBody },
    'POST /v1/workspaces/{workspaceId}/templates': { method: 'post', schema: createTemplateBody },
    'PATCH /v1/templates/{templateId}': { method: 'patch', schema: updateTemplateBody },
    'POST /v1/workspaces/{workspaceId}/templates/{templateId}/instantiate': {
      method: 'post',
      schema: instantiateTemplateBody,
    },
    'POST /v1/workspaces/{workspaceId}/datasets': { method: 'post', schema: createDatasetBody },
    'POST /v1/datasets/{datasetId}/documents': { method: 'post', schema: createDocumentBody },
  };

  for (const [label, { method, schema }] of Object.entries(EXPECTED)) {
    test(`${label} documents the schema it parses`, () => {
      const path = label.slice(method.length + 1);
      const operation = doc.paths[path]?.[method] as
        | { requestBody?: { content?: Record<string, { schema: unknown }> } }
        | undefined;
      assert.ok(operation, `${label} must be documented`);
      const documented = operation.requestBody?.content?.['application/json']?.schema;
      assert.ok(documented, `${label} must document a JSON request body`);
      assert.deepEqual(
        documented,
        schema.toJsonSchema(),
        `${label} request body has drifted from its parse schema`,
      );
    });
  }

  test('covers every body-carrying route the document declares', () => {
    // The map above must not fall behind the document. Collect every operation
    // that declares a JSON request body and assert each is accounted for —
    // either checked above, or explicitly excused (bodies not backed by a shared
    // parse schema: submit-events derives from the UniversalEvent component, and
    // ingress authenticates by signature rather than a typed body).
    const EXCUSED = new Set([
      'POST /v1/sessions/{sessionId}/events',
      'POST /ingress/v1/{workspaceId}/{externalKey}',
    ]);

    const withBodies: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const op = operation as { requestBody?: { content?: Record<string, unknown> } };
        if (op.requestBody?.content?.['application/json']) {
          withBodies.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    const unaccounted = withBodies.filter((key) => !(key in EXPECTED) && !EXCUSED.has(key));
    assert.deepEqual(
      unaccounted,
      [],
      `these routes carry a JSON body but are not checked for drift: ${unaccounted.join(', ')}`,
    );
  });
});
