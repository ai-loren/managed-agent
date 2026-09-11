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

export { nextFireTime, parseCron, validateCron, type CronFields } from './cron.ts';

export { Scheduler, type SchedulerOptions, type TickReport } from './scheduler.ts';
