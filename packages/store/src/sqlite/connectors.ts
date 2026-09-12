/**
 * Trigger-plane repositories: connectors, bindings and receipts.
 *
 * Receipts carry the two guarantees that make inbound delivery trustworthy:
 * `createIfAbsent` deduplicates a retrying source system, and `claimNext`
 * leases work to exactly one worker so a delivery is never processed twice.
 */

import type { Binding, Connector, ConnectorStatus, ErrorInfo, Receipt, ReceiptStatus } from '@ma/contracts';

import type { Database } from '../database.ts';
import {
  buildUpdate,
  readBoolean,
  readJson,
  readNumber,
  readOptionalJson,
  readOptionalNumber,
  readOptionalString,
  readString,
  writeBoolean,
  writeJson,
  writeOptional,
  writeOptionalJson,
  type Row,
} from '../mapping.ts';
import { MAX_PAGE_LIMIT } from '../repository.ts';
import type {
  BindingRepository,
  ConnectorFilter,
  ConnectorRepository,
  DueSchedule,
  Page,
  PageRequest,
  ReceiptFilter,
  ReceiptRepository,
} from '../repository.ts';
import { CrudRepository, condition, inCondition, type Condition, type TableSpec } from './crud.ts';

function optionalNumber(field: string, row: Row, column: string): Record<string, number> {
  const value = readOptionalNumber(row, column);
  return value === undefined ? {} : { [field]: value };
}

function optionalString(field: string, row: Row, column: string): Record<string, string> {
  const value = readOptionalString(row, column);
  return value === undefined ? {} : { [field]: value };
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

const connectorSpec: TableSpec<Connector> = {
  table: 'connectors',
  kind: 'Connector',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    workspaceId: readString(row, 'workspace_id'),
    type: readString(row, 'type') as Connector['type'],
    name: readString(row, 'name'),
    description: readString(row, 'description'),
    status: readString(row, 'status') as ConnectorStatus,
    ...optionalString('agentId', row, 'agent_id'),
    externalKey: readString(row, 'external_key'),
    sessionPolicy: readString(row, 'session_policy') as Connector['sessionPolicy'],
    config: readJson(row, 'config', {}),
    ...optionalString('secretCredentialId', row, 'secret_credential_id'),
    ownerPrincipalId: readString(row, 'owner_principal_id'),
    ...optionalNumber('lastDeliveryAt', row, 'last_delivery_at'),
    ...(readOptionalJson<ErrorInfo>(row, 'error') === undefined
      ? {}
      : { error: readOptionalJson<ErrorInfo>(row, 'error')! }),
    metadata: readJson(row, 'metadata', {}),
    ...optionalNumber('archivedAt', row, 'archived_at'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (connector) => ({
    id: connector.id,
    workspace_id: connector.workspaceId,
    type: connector.type,
    name: connector.name,
    description: connector.description,
    status: connector.status,
    agent_id: writeOptional(connector.agentId),
    external_key: connector.externalKey,
    session_policy: connector.sessionPolicy,
    config: writeJson(connector.config),
    secret_credential_id: writeOptional(connector.secretCredentialId),
    owner_principal_id: connector.ownerPrincipalId,
    last_delivery_at: writeOptional(connector.lastDeliveryAt),
    error: writeOptionalJson(connector.error),
    metadata: writeJson(connector.metadata),
    archived_at: writeOptional(connector.archivedAt),
    created_at: connector.createdAt,
    updated_at: connector.updatedAt,
    created_by: connector.createdBy,
  }),
  updateMapping: {
    name: { column: 'name' },
    description: { column: 'description' },
    status: { column: 'status' },
    agentId: { column: 'agent_id' },
    sessionPolicy: { column: 'session_policy' },
    config: { column: 'config', encode: (value) => writeJson(value) },
    secretCredentialId: { column: 'secret_credential_id' },
    ownerPrincipalId: { column: 'owner_principal_id' },
    lastDeliveryAt: { column: 'last_delivery_at' },
    error: { column: 'error', encode: (value) => writeOptionalJson(value) },
    metadata: { column: 'metadata', encode: (value) => writeJson(value) },
    archivedAt: { column: 'archived_at' },
    updatedAt: { column: 'updated_at' },
    // `externalKey` is deliberately absent: it is immutable after creation
    // because external systems are configured to point at it.
  },
};

export class SqliteConnectorRepository extends CrudRepository<Connector> implements ConnectorRepository {
  constructor(db: Database) {
    super(db, connectorSpec);
  }

  create(connector: Connector): Promise<Connector> {
    return Promise.resolve(this.insert(connector));
  }

  get(id: string): Promise<Connector | undefined> {
    return Promise.resolve(this.findById(id));
  }

  /** Inbound requests address a connector by workspace + key, not by id. */
  getByExternalKey(workspaceId: string, externalKey: string): Promise<Connector | undefined> {
    return Promise.resolve(
      this.findOne([
        condition('workspace_id = ?', workspaceId),
        condition('external_key = ?', externalKey),
      ]),
    );
  }

  update(id: string, patch: Partial<Connector>): Promise<Connector> {
    return Promise.resolve(this.patch(id, patch));
  }

  list(filter: ConnectorFilter): Promise<Page<Connector>> {
    const conditions: Condition[] = [condition('workspace_id = ?', filter.workspaceId)];
    if (filter.type) conditions.push(condition('type = ?', filter.type));
    if (filter.agentId) conditions.push(condition('agent_id = ?', filter.agentId));
    if (filter.status) conditions.push(condition('status = ?', filter.status));
    if (!filter.includeArchived) conditions.push(condition("status != 'archived'"));
    return Promise.resolve(this.page(conditions, filter));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }

  /** Active schedules whose next fire time has arrived. */
  findDueSchedules(now: number, limit: number): Promise<DueSchedule[]> {
    // The rows are read directly rather than through findMany so `fireAt` comes
    // from the same read that decided the row was due. Re-reading it afterwards
    // is what let two replicas claim one tick: the second read the value the
    // first had already advanced, and compare-and-set it to itself.
    const rows = this.db.all(
      `SELECT * FROM connectors
        WHERE type = 'schedule' AND status = 'active'
          AND next_fire_at IS NOT NULL AND next_fire_at <= ?
        ORDER BY next_fire_at ASC
        LIMIT ?`,
      [now, Math.min(limit, MAX_PAGE_LIMIT)],
    );

    return Promise.resolve(
      rows.flatMap((row) => {
        const fireAt = readOptionalNumber(row, 'next_fire_at');
        // The NOT NULL condition makes this unreachable; skipping rather than
        // asserting keeps a surprising row from stopping every other schedule.
        if (fireAt === undefined) return [];
        return [{ connector: connectorSpec.fromRow(row), fireAt }];
      }),
    );
  }

  /**
   * Set the next fire time only if it still matches what the scheduler read.
   *
   * This is what stops two scheduler replicas from both firing one tick: the
   * first advances the time and the second's UPDATE matches no rows.
   */
  claimSchedule(id: string, expectedFireAt: number, nextFireAt: number, at: number): boolean {
    const result = this.db.run(
      'UPDATE connectors SET next_fire_at = ?, updated_at = ? WHERE id = ? AND next_fire_at = ?',
      [nextFireAt, at, id, expectedFireAt],
    );
    return result.changes > 0;
  }

  /** Set the next fire time without a guard — used when (re)activating. */
  setNextFire(id: string, nextFireAt: number | undefined, at: number): void {
    this.db.run('UPDATE connectors SET next_fire_at = ?, updated_at = ? WHERE id = ?', [
      writeOptional(nextFireAt),
      at,
      id,
    ]);
  }

  nextFireAt(id: string): number | undefined {
    const row = this.db.get('SELECT next_fire_at FROM connectors WHERE id = ?', [id]);
    return row ? readOptionalNumber(row, 'next_fire_at') : undefined;
  }
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

const bindingSpec: TableSpec<Binding> = {
  table: 'bindings',
  kind: 'Binding',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    connectorId: readString(row, 'connector_id'),
    workspaceId: readString(row, 'workspace_id'),
    scopeType: readString(row, 'scope_type'),
    scopeKeyHash: readString(row, 'scope_key_hash'),
    scopeLabel: readString(row, 'scope_label'),
    ...optionalString('activeSessionId', row, 'active_session_id'),
    enabled: readBoolean(row, 'enabled'),
    ...optionalNumber('lastDeliveryAt', row, 'last_delivery_at'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (binding) => ({
    id: binding.id,
    connector_id: binding.connectorId,
    workspace_id: binding.workspaceId,
    scope_type: binding.scopeType,
    scope_key_hash: binding.scopeKeyHash,
    scope_label: binding.scopeLabel,
    active_session_id: writeOptional(binding.activeSessionId),
    enabled: writeBoolean(binding.enabled),
    last_delivery_at: writeOptional(binding.lastDeliveryAt),
    created_at: binding.createdAt,
    updated_at: binding.updatedAt,
    created_by: binding.createdBy,
  }),
  updateMapping: {
    scopeLabel: { column: 'scope_label' },
    activeSessionId: { column: 'active_session_id' },
    enabled: { column: 'enabled', encode: (value) => writeBoolean(value as boolean) },
    lastDeliveryAt: { column: 'last_delivery_at' },
    updatedAt: { column: 'updated_at' },
  },
};

export class SqliteBindingRepository extends CrudRepository<Binding> implements BindingRepository {
  constructor(db: Database) {
    super(db, bindingSpec);
  }

  create(binding: Binding): Promise<Binding> {
    return Promise.resolve(this.insert(binding));
  }

  get(id: string): Promise<Binding | undefined> {
    return Promise.resolve(this.findById(id));
  }

  findByScope(connectorId: string, scopeKeyHash: string): Promise<Binding | undefined> {
    return Promise.resolve(
      this.findOne([
        condition('connector_id = ?', connectorId),
        condition('scope_key_hash = ?', scopeKeyHash),
      ]),
    );
  }

  update(id: string, patch: Partial<Binding>): Promise<Binding> {
    return Promise.resolve(this.patch(id, patch));
  }

  listForConnector(connectorId: string, page: PageRequest): Promise<Page<Binding>> {
    return Promise.resolve(this.page([condition('connector_id = ?', connectorId)], page));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }

  deleteForConnector(connectorId: string): Promise<void> {
    this.db.run('DELETE FROM bindings WHERE connector_id = ?', [connectorId]);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

const receiptSpec: TableSpec<Receipt> = {
  table: 'receipts',
  kind: 'Receipt',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    connectorId: readString(row, 'connector_id'),
    workspaceId: readString(row, 'workspace_id'),
    ...optionalString('bindingId', row, 'binding_id'),
    externalEventId: readString(row, 'external_event_id'),
    status: readString(row, 'status') as ReceiptStatus,
    ...optionalString('sessionId', row, 'session_id'),
    attempt: readNumber(row, 'attempt'),
    maxAttempts: readNumber(row, 'max_attempts'),
    ...optionalNumber('nextAttemptAt', row, 'next_attempt_at'),
    ...optionalNumber('leaseExpiresAt', row, 'lease_expires_at'),
    ...optionalNumber('startedAt', row, 'started_at'),
    ...optionalNumber('completedAt', row, 'completed_at'),
    ...(readOptionalJson<ErrorInfo>(row, 'error') === undefined
      ? {}
      : { error: readOptionalJson<ErrorInfo>(row, 'error')! }),
    payloadSummary: readString(row, 'payload_summary'),
    responseContext: readJson(row, 'response_context', {}),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (receipt) => ({
    id: receipt.id,
    connector_id: receipt.connectorId,
    workspace_id: receipt.workspaceId,
    binding_id: writeOptional(receipt.bindingId),
    external_event_id: receipt.externalEventId,
    status: receipt.status,
    session_id: writeOptional(receipt.sessionId),
    attempt: receipt.attempt,
    max_attempts: receipt.maxAttempts,
    next_attempt_at: writeOptional(receipt.nextAttemptAt),
    lease_expires_at: writeOptional(receipt.leaseExpiresAt),
    started_at: writeOptional(receipt.startedAt),
    completed_at: writeOptional(receipt.completedAt),
    error: writeOptionalJson(receipt.error),
    payload_summary: receipt.payloadSummary,
    response_context: writeJson(receipt.responseContext),
    created_at: receipt.createdAt,
    updated_at: receipt.updatedAt,
    created_by: receipt.createdBy,
  }),
  updateMapping: {
    status: { column: 'status' },
    sessionId: { column: 'session_id' },
    bindingId: { column: 'binding_id' },
    attempt: { column: 'attempt' },
    maxAttempts: { column: 'max_attempts' },
    nextAttemptAt: { column: 'next_attempt_at' },
    leaseExpiresAt: { column: 'lease_expires_at' },
    startedAt: { column: 'started_at' },
    completedAt: { column: 'completed_at' },
    error: { column: 'error', encode: (value) => writeOptionalJson(value) },
    payloadSummary: { column: 'payload_summary' },
    responseContext: { column: 'response_context', encode: (value) => writeJson(value) },
    updatedAt: { column: 'updated_at' },
  },
};

export class SqliteReceiptRepository extends CrudRepository<Receipt> implements ReceiptRepository {
  constructor(db: Database) {
    super(db, receiptSpec);
  }

  /**
   * The idempotency guarantee for inbound triggers.
   *
   * A source system that retries — because our response was slow, or its own
   * delivery worker restarted — must not start a second agent run. The unique
   * index on `(connector_id, external_event_id)` makes the insert fail, and we
   * return the original receipt so the caller can report its real fate rather
   * than pretending a fresh delivery happened.
   */
  createIfAbsent(receipt: Receipt): Promise<{ receipt: Receipt; created: boolean }> {
    const outcome = this.db.transaction(() => {
      const existing = this.findOne([
        condition('connector_id = ?', receipt.connectorId),
        condition('external_event_id = ?', receipt.externalEventId),
      ]);
      if (existing) return { receipt: existing, created: false };
      return { receipt: this.insert(receipt), created: true };
    });
    return Promise.resolve(outcome);
  }

  get(id: string): Promise<Receipt | undefined> {
    return Promise.resolve(this.findById(id));
  }

  update(id: string, patch: Partial<Receipt>): Promise<Receipt> {
    return Promise.resolve(this.patch(id, patch));
  }

  list(filter: ReceiptFilter): Promise<Page<Receipt>> {
    const conditions: Condition[] = [];
    if (filter.connectorId) conditions.push(condition('connector_id = ?', filter.connectorId));
    if (filter.workspaceId) conditions.push(condition('workspace_id = ?', filter.workspaceId));
    if (filter.bindingId) conditions.push(condition('binding_id = ?', filter.bindingId));
    if (filter.sessionId) conditions.push(condition('session_id = ?', filter.sessionId));
    const statuses = inCondition('status', filter.statuses ?? []);
    if (statuses) conditions.push(statuses);
    if (filter.createdAfter !== undefined) conditions.push(condition('created_at >= ?', filter.createdAfter));
    if (filter.createdBefore !== undefined) conditions.push(condition('created_at < ?', filter.createdBefore));
    return Promise.resolve(this.page(conditions, filter));
  }

  /**
   * Take one due receipt and lease it to this worker.
   *
   * Select and claim happen in one transaction so two workers cannot both take
   * the same delivery. The lease — rather than a plain "working" flag — is what
   * lets the reaper distinguish a slow worker from a dead one.
   */
  claimNext(now: number, leaseExpiresAt: number): Promise<Receipt | undefined> {
    const claimed = this.db.transaction(() => {
      const row = this.db.get(
        `SELECT * FROM receipts
          WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY created_at ASC LIMIT 1`,
        [now],
      );
      if (!row) return undefined;

      const receipt = receiptSpec.fromRow(row);
      const result = this.db.run(
        `UPDATE receipts
            SET status = 'working', lease_expires_at = ?, started_at = ?, attempt = attempt + 1,
                updated_at = ?
          WHERE id = ? AND status = 'pending'`,
        [leaseExpiresAt, receipt.startedAt ?? now, now, receipt.id],
      );
      if (result.changes === 0) return undefined;
      return this.findById(receipt.id);
    });
    return Promise.resolve(claimed);
  }

  compareAndSetStatus(
    id: string,
    expected: ReceiptStatus,
    patch: Partial<Receipt>,
  ): Promise<Receipt | undefined> {
    const { clause, values } = buildUpdate(
      patch as Record<string, unknown>,
      receiptSpec.updateMapping,
    );
    if (clause === '') return Promise.resolve(this.findById(id));

    const result = this.db.run(`UPDATE receipts SET ${clause} WHERE id = ? AND status = ?`, [
      ...values,
      id,
      expected,
    ]);
    // No rows means the status moved: the caller's view is stale and it must
    // not write over whatever replaced it.
    if (result.changes === 0) return Promise.resolve(undefined);
    return Promise.resolve(this.findById(id));
  }

  /** `working` receipts whose worker stopped heartbeating — become zombies. */
  findExpiredLeases(now: number, limit: number): Promise<Receipt[]> {
    return Promise.resolve(
      this.findMany(
        [
          condition("status = 'working'"),
          condition('lease_expires_at IS NOT NULL'),
          condition('lease_expires_at < ?', now),
        ],
        { orderBy: 'lease_expires_at', limit },
      ),
    );
  }

  deleteForConnector(connectorId: string): Promise<void> {
    this.db.run('DELETE FROM receipts WHERE connector_id = ?', [connectorId]);
    return Promise.resolve();
  }

  countByStatus(): Promise<Record<string, number>> {
    const rows = this.db.all('SELECT status, COUNT(*) AS n FROM receipts GROUP BY status');
    const out: Record<string, number> = {};
    for (const row of rows) out[String(row.status)] = Number(row.n);
    return Promise.resolve(out);
  }
}
