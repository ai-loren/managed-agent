/**
 * `@ma/sandbox` — the broker and its drivers.
 */

export {
  SANDBOX_ERROR_CODES,
  type ProvisionRequest,
  type ProvisionedSandbox,
  type SandboxDriver,
  type SandboxErrorCode,
  type SandboxHealth,
} from './driver.ts';

export {
  SandboxBroker,
  WARM_DECLARATION_TTL_MS,
  computePoolKey,
  type AcquireRequest,
  type AcquireResult,
  type BrokerOptions,
  type PoolKeyInput,
} from './broker.ts';

export { LocalSandboxDriver, type LocalDriverOptions } from './local-driver.ts';

export { VolumeManager, type VolumeManagerOptions } from './volumes.ts';

export { confineServiceAccount } from './identity.ts';

export { egressProxyEnv, signEgressGrant, type EgressGrant } from './egress-grant.ts';

export {
  ContainerSandboxDriver,
  type ContainerDriverOptions,
} from './container-driver.ts';

export {
  K8sSandboxDriver,
  parseKubePods,
  type K8sDriverOptions,
  type KubeClient,
  type KubeNetworkPolicy,
  type KubeEgressRule,
  type KubePods,
  type KubePod,
  type KubePodSpec,
  type KubePodMount,
  type KubeProbePodSpec,
  type KubeSecret,
} from './k8s-driver.ts';

export {
  probeNetworkPolicyEnforcement,
  type NetworkPolicyEnforcement,
  type NetworkPolicyProbeOptions,
} from './netpol-probe.ts';

export {
  KubeHttpClient,
  toPodManifest,
  toSecretManifest,
  toNetworkPolicyManifest,
  fromPodObject,
  type KubeHttpClientOptions,
} from './kube-http-client.ts';
