/**
 * Files people attach to a session's messages, put where the agent can work on
 * them.
 *
 * Each file is fetched from the control plane, which serves a sandbox only the
 * files attached to its own session, checked against the digest it was
 * announced with, and written to `attachments/<name>` in the session's working
 * directory. The prompt that carried it says where it is, or why it is not
 * there: an agent told nothing would go looking for the file, or answer as if
 * it had read it.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MaError, type Clock, type Logger } from '@ma/core';

/** Where attached files go, relative to the working directory. */
export const ATTACHMENTS_DIR = 'attachments';

/** An attached file, as the control plane announces it. */
export interface AttachedFile {
  artifactId: string;
  name: string;
  digest: string;
  sizeBytes: number;
  contentType: string;
}

/** Where a file was put, relative to the working directory, or why it was not. */
export type Delivery = { file: AttachedFile; path: string } | { file: AttachedFile; failure: string };

/** Waits between attempts at a fetch that failed for a reason that can pass. */
const RETRY_MS = [500, 2_000] as const;

/**
 * The well-formed files in a submit or bootstrap body. A name that is a path
 * rather than a file name would write outside the attachments directory, so a
 * file announced with one is dropped, not trusted.
 */
export function parseAttachedFiles(value: unknown): AttachedFile[] {
  if (!Array.isArray(value)) return [];
  return value.filter((file): file is AttachedFile => {
    if (!file || typeof file !== 'object') return false;
    const { artifactId, name, digest, sizeBytes, contentType } = file as Record<string, unknown>;
    return (
      typeof artifactId === 'string' &&
      typeof name === 'string' &&
      name.length > 0 &&
      name !== '.' &&
      name !== '..' &&
      !/[/\\\0]/.test(name) &&
      typeof digest === 'string' &&
      /^[0-9a-f]{64}$/.test(digest) &&
      typeof sizeBytes === 'number' &&
      typeof contentType === 'string'
    );
  });
}

/**
 * Fetch each file and write it to the working directory, in order. A file that
 * cannot be delivered is reported, not thrown: the others still arrive, and the
 * turn still runs, told what is missing.
 */
export async function deliverAttachments(
  files: readonly AttachedFile[],
  workDir: string,
  fetchFile: (artifactId: string) => Promise<Uint8Array>,
  clock: Clock,
  logger: Logger,
  signal?: AbortSignal,
): Promise<Delivery[]> {
  const deliveries: Delivery[] = [];
  for (const file of files) {
    signal?.throwIfAborted();
    const path = `${ATTACHMENTS_DIR}/${file.name}`;
    let content: Uint8Array;
    try {
      content = await fetchWithRetry(file.artifactId, fetchFile, clock, signal);
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn('could not fetch an attached file', { artifactId: file.artifactId, error });
      deliveries.push({ file, failure: `it could not be fetched (${reasonOf(error)})` });
      continue;
    }
    // A fetch already under way is not cancelled by the signal; a stop that
    // came meanwhile must still stop the delivery, and with it the turn.
    signal?.throwIfAborted();
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== file.digest) {
      logger.error('an attached file arrived with the wrong digest', { artifactId: file.artifactId, expected: file.digest, actual: digest });
      deliveries.push({ file, failure: 'it arrived damaged, so it was not written' });
      continue;
    }
    try {
      await mkdir(join(workDir, ATTACHMENTS_DIR), { recursive: true });
      await writeFile(join(workDir, path), content);
    } catch (error) {
      logger.error('could not write an attached file', { artifactId: file.artifactId, path, error });
      deliveries.push({ file, failure: `it could not be written (${reasonOf(error)})` });
      continue;
    }
    deliveries.push({ file, path });
  }
  return deliveries;
}

/** The note a prompt carries about its files. Empty when it has none. */
export function describeAttachments(deliveries: readonly Delivery[]): string {
  if (deliveries.length === 0) return '';
  const lines = deliveries.map((delivery) =>
    'path' in delivery
      ? `- ${delivery.path} (${delivery.file.contentType}, ${formatSize(delivery.file.sizeBytes)})`
      : `- ${delivery.file.name}: not in the working directory, because ${delivery.failure}`,
  );
  return ['Files attached to this message, relative to the working directory:', ...lines].join('\n');
}

async function fetchWithRetry(
  artifactId: string,
  fetchFile: (artifactId: string) => Promise<Uint8Array>,
  clock: Clock,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchFile(artifactId);
    } catch (error) {
      // A refusal (not attached, content deleted) answers the same every time;
      // an unreachable or failing control plane may not.
      const transient = !(error instanceof MaError) || error.retryable === true;
      const wait = RETRY_MS[attempt];
      if (!transient || wait === undefined) throw error;
      await clock.sleep(wait, signal);
    }
  }
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
