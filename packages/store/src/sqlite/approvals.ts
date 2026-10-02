/**
 * Tool calls waiting on a person, and their answers.
 */

import type { Approval } from '@ma/contracts';

import type { SqlDatabase } from '../database.ts';
import {
  readJson,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readString,
  writeJson,
  writeOptional,
  type Row,
} from '../mapping.ts';
import type { ApprovalFilter, ApprovalOutcome, ApprovalRepository, Page } from '../repository.ts';
import { condition, CrudRepository, inCondition, type Condition, type TableSpec } from './crud.ts';

const approvalSpec: TableSpec<Approval> = {
  table: 'approvals',
  kind: 'Approval',
  fromRow: (row) => {
    const decidedAt = readOptionalNumber(row, 'decided_at');
    const decidedBy = readOptionalString(row, 'decided_by');
    const sandboxId = readOptionalString(row, 'sandbox_id');
    return {
      id: readString(row, 'id'),
      sessionId: readString(row, 'session_id'),
      workspaceId: readString(row, 'workspace_id'),
      ...(sandboxId === undefined ? {} : { sandboxId }),
      turn: readNumber(row, 'turn'),
      toolCallId: readString(row, 'tool_call_id'),
      toolName: readString(row, 'tool_name'),
      input: readJson<Record<string, unknown>>(row, 'input', {}),
      reason: readString(row, 'reason'),
      status: readString(row, 'status') as Approval['status'],
      requestedAt: readNumber(row, 'requested_at'),
      expiresAt: readNumber(row, 'expires_at'),
      ...(decidedAt === undefined ? {} : { decidedAt }),
      ...(decidedBy === undefined ? {} : { decidedBy }),
      decisionReason: readString(row, 'decision_reason'),
    };
  },
  toColumns: (approval) => ({
    id: approval.id,
    session_id: approval.sessionId,
    workspace_id: approval.workspaceId,
    sandbox_id: writeOptional(approval.sandboxId),
    turn: approval.turn,
    tool_call_id: approval.toolCallId,
    tool_name: approval.toolName,
    input: writeJson(approval.input),
    reason: approval.reason,
    status: approval.status,
    requested_at: approval.requestedAt,
    expires_at: approval.expiresAt,
    decided_at: writeOptional(approval.decidedAt),
    decided_by: writeOptional(approval.decidedBy),
    decision_reason: approval.decisionReason,
  }),
  // Settled only through the compare-and-set methods below: a plain patch could
  // overwrite one outcome with another.
  updateMapping: {},
};

export class SqliteApprovalRepository extends CrudRepository<Approval> implements ApprovalRepository {
  constructor(db: SqlDatabase) {
    super(db, approvalSpec);
  }

  createIfAbsent(approval: Approval): Promise<{ approval: Approval; created: boolean }> {
    return Promise.resolve(
      this.db.transaction(() => {
        const existing = this.findOne([
          condition('session_id = ?', approval.sessionId),
          condition('tool_call_id = ?', approval.toolCallId),
        ]);
        if (existing) return { approval: existing, created: false };
        return { approval: this.insert(approval), created: true };
      }),
    );
  }

  get(id: string): Promise<Approval | undefined> {
    return Promise.resolve(this.findById(id));
  }

  list(filter: ApprovalFilter): Promise<Page<Approval>> {
    const conditions: Condition[] = [];
    if (filter.workspaceId !== undefined) conditions.push(condition('workspace_id = ?', filter.workspaceId));
    if (filter.sessionId !== undefined) conditions.push(condition('session_id = ?', filter.sessionId));
    const statuses = inCondition('status', filter.statuses ?? []);
    if (statuses) conditions.push(statuses);
    return Promise.resolve(this.page(conditions, filter));
  }

  decide(id: string, outcome: ApprovalOutcome, now: number): Promise<Approval | undefined> {
    return Promise.resolve(
      this.#settle(
        `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?
          RETURNING *`,
        [outcome.status, now, outcome.decidedBy ?? null, outcome.reason, id, now],
      )[0],
    );
  }

  expire(id: string, now: number, reason: string): Promise<Approval | undefined> {
    return Promise.resolve(
      this.#settle(
        `UPDATE approvals SET status = 'expired', decided_at = ?, decision_reason = ?
          WHERE id = ? AND status = 'pending' AND expires_at <= ?
          RETURNING *`,
        [now, reason, id, now],
      )[0],
    );
  }

  findDue(now: number, limit: number): Promise<Approval[]> {
    const rows = this.db.all(
      `SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at, id LIMIT ?`,
      [now, Math.max(1, Math.trunc(limit))],
    );
    return Promise.resolve(rows.map((row) => approvalSpec.fromRow(row)));
  }

  cancelPending(sessionId: string, now: number, reason: string, throughTurn?: number): Promise<Approval[]> {
    return Promise.resolve(
      this.#settle(
        `UPDATE approvals SET status = 'cancelled', decided_at = ?, decision_reason = ?
          WHERE session_id = ? AND status = 'pending' ${throughTurn === undefined ? '' : 'AND turn <= ?'}
          RETURNING *`,
        [now, reason, sessionId, ...(throughTurn === undefined ? [] : [throughTurn])],
      ),
    );
  }

  #settle(sql: string, values: (string | number | null)[]): Approval[] {
    return this.db.all(sql, values).map((row: Row) => approvalSpec.fromRow(row));
  }
}
