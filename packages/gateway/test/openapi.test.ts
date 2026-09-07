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

import { buildOpenApi } from '../src/index.ts';

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
      ['/health', '/ingress/v1/{workspaceId}/{externalKey}'],
      'health is unauthenticated; ingress authenticates by signature instead',
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
