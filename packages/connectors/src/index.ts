/**
 * `@ma/connectors` — the trigger plane.
 */

export {
  AdapterRegistry,
  type ConnectorAdapter,
  type DeliveryOutcome,
  type InboundRequest,
  type TriggerEvent,
  type VerifyResult,
} from './adapter.ts';

export {
  chatAdapter,
  eventBusAdapter,
  hookAdapter,
  scheduleAdapter,
  scheduleTrigger,
  webhookAdapter,
  type ChatAdapterOptions,
  type EventBusAdapterOptions,
  type HookAdapterOptions,
  type WebhookAdapterOptions,
} from './adapters.ts';

export {
  DeliveryPipeline,
  type DeliveryResult,
  type PipelineOptions,
} from './pipeline.ts';

export { hookCallbackPoster, parseCallbackOrigins, type HookCallbackOptions } from './hook-callback.ts';

export { nextFireTime, parseCron, validateCron, type CronFields } from './cron.ts';

export { Scheduler, type SchedulerOptions, type TickReport } from './scheduler.ts';

export {
  PullSupervisor,
  type PullBatch,
  type PullOutcome,
  type PullSettings,
  type PullSource,
  type PullSourceFactory,
  type PullSupervisorOptions,
} from './pull/supervisor.ts';
export { normalizePulled, type PulledEventConfig, type PulledMessage } from './pull/message.ts';
export {
  brokerAllowed,
  kafkaAdapter,
  parseKafkaBrokers,
  parseSqsEndpoints,
  sqsAdapter,
  sqsRegion,
  type SqsEndpointPolicy,
} from './pull/adapters.ts';
export { signV4, type AwsCredentials } from './pull/sigv4.ts';
export { SqsClient, sqsSourceFactory, type SqsClientOptions, type SqsMessage, type SqsSourceOptions } from './pull/sqs.ts';
export { kafkaSourceFactory, type KafkaSourceOptions } from './pull/kafka/consumer.ts';
