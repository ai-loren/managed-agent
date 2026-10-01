/**
 * The egress proxy image, in the topology it is built for. Needs Docker; runs
 * when MA_E2E_DOCKER=1 (CI's docker-e2e job sets it).
 *
 * A client container sits on an `--internal` network, as a restricted sandbox
 * does. The proxy, built from deploy/egress-proxy/Dockerfile, sits on that
 * network and on one with a way out, where an upstream service lives. With a
 * grant the platform signed, the client reaches the one upstream its allowlist
 * names, through the proxy, and nothing else: not another service, not the
 * upstream directly, not a metadata address under an allowlisted name.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { signEgressGrant } from '@ma/sandbox';

const enabled = process.env.MA_E2E_DOCKER === '1';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SECRET = randomBytes(32).toString('base64url');
const suffix = randomBytes(4).toString('hex');
const IMAGE = `ma-egress-proxy:e2e-${suffix}`;
const INTERNAL = `ma-e2e-internal-${suffix}`;
const OUTSIDE = `ma-e2e-outside-${suffix}`;
const PROXY = `ma-e2e-proxy-${suffix}`;
const UPSTREAM = `ma-e2e-upstream-${suffix}`;
const OTHER = `ma-e2e-other-${suffix}`;

function docker(args: string[], timeoutMs = 300_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('docker', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr });
    });
  });
}

async function must(args: string[]): Promise<string> {
  const result = await docker(args);
  assert.equal(result.code, 0, `docker ${args.join(' ')}\n${result.err}`);
  return result.out.trim();
}

/** curl from a container on the internal network only, as a sandbox's tool would run it. */
function fromSandbox(curlArgs: string[]): Promise<{ code: number; out: string; err: string }> {
  return docker(['run', '--rm', '--network', INTERNAL, 'node:24', 'curl', '-s', '-S', '-m', '10', ...curlArgs], 60_000);
}

function proxyUrl(hosts: string[]): string {
  const grant = signEgressGrant(SECRET, { sid: 'sb_e2e', hosts, exp: Date.now() + 600_000 });
  return `http://sb_e2e:${grant}@${PROXY}:3128`;
}

describe('the egress proxy image', { skip: enabled ? false : 'set MA_E2E_DOCKER=1 to run against Docker' }, () => {
  before(async () => {
    await must(['build', '-t', IMAGE, '-f', `${ROOT}deploy/egress-proxy/Dockerfile`, `${ROOT}apps/egress-proxy`]);
    await must(['network', 'create', '--internal', INTERNAL]);
    await must(['network', 'create', OUTSIDE]);
    const outsideSubnet = await must(['network', 'inspect', OUTSIDE, '--format', '{{(index .IPAM.Config 0).Subnet}}']);
    const server = (body: string) => `require('http').createServer((q,r)=>r.end('${body} '+q.url)).listen(8080)`;
    await must(['run', '-d', '--name', UPSTREAM, '--network', OUTSIDE, 'node:24-alpine', 'node', '-e', server('upstream-says')]);
    await must(['run', '-d', '--name', OTHER, '--network', OUTSIDE, 'node:24-alpine', 'node', '-e', server('other-says')]);
    await must([
      'run', '-d', '--name', PROXY, '--network', INTERNAL,
      '-e', `MA_EGRESS_PROXY_SECRET=${SECRET}`,
      // The upstream lives on a private Docker network, which the proxy refuses by default.
      '-e', `MA_EGRESS_PROXY_ALLOW_CIDRS=${outsideSubnet}`,
      '--add-host', 'metadata.e2e.test:169.254.169.254',
      IMAGE,
    ]);
    await must(['network', 'connect', OUTSIDE, PROXY]);
    for (let attempt = 0; attempt < 50; attempt++) {
      const health = await docker(['inspect', PROXY, '--format', '{{.State.Health.Status}}']);
      if (health.out.trim() === 'healthy') return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.fail(`the proxy never became healthy:\n${(await docker(['logs', PROXY])).out}`);
  });

  after(async () => {
    await docker(['rm', '-f', PROXY, UPSTREAM, OTHER]);
    await docker(['network', 'rm', INTERNAL, OUTSIDE]);
    await docker(['rmi', '-f', IMAGE]);
  });

  test('a sandbox reaches the upstream its allowlist names, through the proxy', async () => {
    const result = await fromSandbox(['-x', proxyUrl([`${UPSTREAM}:8080`]), `http://${UPSTREAM}:8080/hello`]);
    assert.equal(result.out, 'upstream-says /hello', result.err);
  });

  test('another service on the same network is refused', async () => {
    const result = await fromSandbox(['-f', '-x', proxyUrl([`${UPSTREAM}:8080`]), `http://${OTHER}:8080/`]);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.out, /other-says/);
    assert.match(result.err, /403/);
  });

  test('without a grant nothing gets through', async () => {
    const result = await fromSandbox(['-f', '-x', `http://${PROXY}:3128`, `http://${UPSTREAM}:8080/`]);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /407/);
  });

  test('an allowlisted name that points at the metadata address is refused', async () => {
    const result = await fromSandbox(['-f', '-x', proxyUrl(['metadata.e2e.test:80']), 'http://metadata.e2e.test/latest/meta-data/']);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /403/);
  });

  test('the upstream is out of reach without the proxy: the internal network is the boundary', async () => {
    const result = await fromSandbox(['-m', '5', `http://${UPSTREAM}:8080/`]);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.out, /upstream-says/);
  });

  test('every decision is logged with the sandbox it was made for', async () => {
    const logs = (await docker(['logs', PROXY])).out;
    assert.match(logs, /"event":"egress.forward","sid":"sb_e2e"/);
    assert.match(logs, /"event":"egress.refused","sid":"sb_e2e".*"status":403/);
  });
});
