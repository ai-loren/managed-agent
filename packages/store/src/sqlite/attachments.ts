/**
 * Files attached to a session's messages: which artifacts its sandbox may read,
 * in the order they were attached, and the name each one has there.
 */

import type { SqlDatabase } from '../database.ts';
import { readNumber, readString, type Row } from '../mapping.ts';
import type { SessionAttachment, SessionAttachmentRepository } from '../repository.ts';

/** Under any filesystem's 255-byte limit, with room for a ` (n)` suffix. */
const MAX_NAME_BYTES = 200;

function fromRow(row: Row): SessionAttachment {
  return {
    sessionId: readString(row, 'session_id'),
    artifactId: readString(row, 'artifact_id'),
    position: readNumber(row, 'position'),
    name: readString(row, 'name'),
    attachedAt: readNumber(row, 'attached_at'),
    attachedBy: readString(row, 'attached_by'),
  };
}

/**
 * A file name for an artifact at `path` that no name in `taken` already has,
 * ignoring case: `report.csv`, then `report (2).csv`, `report (3).csv`.
 *
 * The path is an artifact label, already free of control characters and of
 * `.`/`..` segments; only its last segment is used.
 */
export function attachmentFileName(path: string, taken: ReadonlySet<string>): string {
  const base = (path.split('/').pop() ?? '').normalize('NFC') || 'file';
  const dot = base.lastIndexOf('.');
  const hasExtension = dot > 0 && base.length - dot <= 16;
  const extension = hasExtension ? base.slice(dot) : '';
  let stem = hasExtension ? base.slice(0, dot) : base;
  while (Buffer.byteLength(stem + extension) > MAX_NAME_BYTES) stem = [...stem].slice(0, -1).join('');

  const used = new Set([...taken].map((name) => name.toLowerCase()));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${stem}${extension}` : `${stem} (${n})${extension}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export class SqliteSessionAttachmentRepository implements SessionAttachmentRepository {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  attach(
    sessionId: string,
    artifacts: readonly { artifactId: string; path: string }[],
    attachedBy: string,
    now: number,
  ): Promise<SessionAttachment[]> {
    return Promise.resolve(
      // Position and name are chosen from the rows already there, so both are
      // read and written in one transaction; the unique indexes refuse what a
      // concurrent writer on another replica might still collide on.
      this.#db.transaction(() => {
        const existing = this.#list(sessionId);
        const attached = new Set(existing.map((row) => row.artifactId));
        const taken = new Set(existing.map((row) => row.name));
        let position = existing.length === 0 ? 0 : existing[existing.length - 1]!.position + 1;
        for (const { artifactId, path } of artifacts) {
          if (attached.has(artifactId)) continue;
          const name = attachmentFileName(path, taken);
          this.#db.run(
            `INSERT INTO session_attachments (session_id, artifact_id, position, name, attached_at, attached_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [sessionId, artifactId, position, name, now, attachedBy],
          );
          attached.add(artifactId);
          taken.add(name);
          position++;
        }
        return this.#list(sessionId);
      }),
    );
  }

  list(sessionId: string): Promise<SessionAttachment[]> {
    return Promise.resolve(this.#list(sessionId));
  }

  has(sessionId: string, artifactId: string): Promise<boolean> {
    return Promise.resolve(
      this.#db.get('SELECT 1 AS found FROM session_attachments WHERE session_id = ? AND artifact_id = ?', [sessionId, artifactId]) !==
        undefined,
    );
  }

  #list(sessionId: string): SessionAttachment[] {
    return this.#db
      .all('SELECT * FROM session_attachments WHERE session_id = ? ORDER BY position', [sessionId])
      .map(fromRow);
  }
}
