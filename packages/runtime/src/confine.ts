/**
 * Keeping a sandbox's own subprocesses off the network.
 *
 * The container and Kubernetes drivers fence the whole sandbox at the network
 * layer. The local driver cannot fence agent-core itself — it must keep talking
 * to the control plane — so when it enforces a restricted egress policy it sets
 * `MA_EGRESS_CONFINE`, and every place agent-core starts code the agent
 * controls (shell and skill tools, MCP stdio servers, setup commands, a command
 * runtime) starts it through `confineCommand`. The confinement is inherited by
 * everything that code starts in turn.
 *
 *  - `seatbelt:<profile>` — macOS `sandbox-exec -p <profile>`.
 *  - `netns` — Linux `unshare --net --map-root-user`: a network namespace whose
 *    only interface is an unconfigured loopback.
 */

export const CONFINE_ENV = 'MA_EGRESS_CONFINE';

export function confineCommand(
  executable: string,
  args: readonly string[],
  confine: string | undefined = process.env[CONFINE_ENV],
): { executable: string; args: string[] } {
  if (confine === undefined || confine === '') return { executable, args: [...args] };
  if (confine.startsWith('seatbelt:')) {
    return { executable: '/usr/bin/sandbox-exec', args: ['-p', confine.slice('seatbelt:'.length), executable, ...args] };
  }
  if (confine === 'netns') {
    return { executable: 'unshare', args: ['--net', '--map-root-user', '--', executable, ...args] };
  }
  throw new Error(
    `${CONFINE_ENV} must be 'seatbelt:<profile>' or 'netns', got ${JSON.stringify(confine.slice(0, 40))}. ` +
      'It is set by the local sandbox driver; unset it to run unconfined.',
  );
}

/** Whether subprocesses are confined, i.e. this sandbox's egress is restricted by the local driver. */
export function egressConfined(confine: string | undefined = process.env[CONFINE_ENV]): boolean {
  return confine !== undefined && confine !== '';
}

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

/**
 * The proxy settings a driver gave this sandbox, for the tools' environment.
 * Tools start from a minimal environment, so without this an allowlisted
 * sandbox's tools would never find the proxy that is their only way out.
 */
export function proxyEnvFrom(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PROXY_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}
