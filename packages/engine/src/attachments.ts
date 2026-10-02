/**
 * Files a person hands a session's agent.
 *
 * A message attaches artifacts of the session's workspace — usually ones just
 * uploaded to the session — by id. Attaching is what lets the session's
 * sandbox read a file: the attachment row is the grant, and the runtime bridge
 * serves a sandbox no artifact without one.
 */

import type { Logger } from '@ma/core';
import type { Store } from '@ma/store';

/** A file attached to a session, as its sandbox is given it. */
export interface SessionFile {
  artifactId: string;
  /** Unique within the session: the sandbox writes the file to `attachments/<name>`. */
  name: string;
  /** SHA-256 of the content, which the sandbox checks what it receives against. */
  digest: string;
  sizeBytes: number;
  contentType: string;
}

/**
 * A session's attached files in the order they were attached, or the ones in
 * `only`, in that order. A file whose content has since been deleted is still
 * listed: the sandbox finds that out when it asks for it, and says so to the
 * agent rather than leaving it to look for a file that is not there.
 */
export async function sessionFiles(
  store: Store,
  sessionId: string,
  only?: readonly string[],
  logger?: Logger,
): Promise<SessionFile[]> {
  const rows = await store.sessionAttachments.list(sessionId);
  const wanted =
    only === undefined
      ? rows
      : only.flatMap((artifactId) => rows.filter((row) => row.artifactId === artifactId));
  const files: SessionFile[] = [];
  for (const row of wanted) {
    const artifact = await store.artifacts.get(row.artifactId);
    if (!artifact) {
      logger?.warn('an attached artifact has no record', { sessionId, artifactId: row.artifactId });
      continue;
    }
    files.push({
      artifactId: artifact.id,
      name: row.name,
      digest: artifact.digest,
      sizeBytes: artifact.sizeBytes,
      contentType: artifact.contentType,
    });
  }
  return files;
}
