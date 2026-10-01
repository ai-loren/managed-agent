/**
 * Operator-listed origins: what an outbound request may reach.
 *
 * The comparison with a request's `URL.origin` is exact, so an entry is
 * normalized the same way — scheme and host lowercased, a default port dropped
 * — rather than refused for being written differently from how `URL` prints it.
 */

/**
 * The origin an entry names, or `undefined` unless it is exactly an http(s)
 * origin: anything else it carries — a path, query, fragment or credentials —
 * would be silently ignored by the comparison, so it is refused instead.
 */
export function exactOrigin(entry: string): string | undefined {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined;
  return url.origin;
}

/** An entry fit to repeat in an error: any credentials in it are masked. */
export function redactCredentials(entry: string): string {
  return entry.replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i, (_match, scheme: string | undefined) => `${scheme ?? ''}***@`);
}
