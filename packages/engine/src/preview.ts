/**
 * Artifact preview: rendering agent-authored bytes safely.
 *
 * Downloading an artifact is already safe — the bytes come back as an
 * `attachment` with a sniffed, never-executable content type. Previewing means
 * the opposite: rendering the bytes in a browser. That is dangerous for exactly
 * one reason, and the whole design follows from it: **the console is served from
 * the same origin as the API**, so an agent-authored page rendered there would
 * run with the operator's session — read its token, call the API as them.
 *
 * The defence is a *separate origin*. Preview content is served only from a
 * configured `previewOrigin` distinct from the API's, so even a hostile page has
 * no access to console cookies or storage — a cross-origin boundary the browser
 * enforces. Layered on top:
 *
 *  - A **signed, expiring token** authorises each preview, so the endpoint needs
 *    no bearer (a browser navigation or an `<iframe>` carries none) yet cannot
 *    be pointed at an arbitrary artifact.
 *  - A **strict CSP** (`default-src 'none'; sandbox; frame-ancestors <console>`)
 *    so the content can load nothing, run in a sandbox, and be embedded only by
 *    the console.
 *
 * If no separate origin is configured, preview is **disabled** — minting a token
 * throws. Shipping it same-origin would be the "control that reads as enforced
 * and is not" this codebase refuses to build, so the safe default is off.
 */

import { hmacSha256Hex, newId, safeEqual, type Clock } from '@ma/core';
import type { KeyProvider } from '@ma/core';

import { MaError } from '@ma/core';

export interface PreviewOptions {
  clock: Clock;
  keys: KeyProvider;
  /**
   * The distinct origin preview content is served from, e.g.
   * `https://artifacts.example.com`. Absent disables preview entirely.
   */
  previewOrigin?: string;
  /**
   * The console's origin, named in `frame-ancestors` so only it may embed a
   * preview. Absent means no one may frame it (`frame-ancestors 'none'`).
   */
  consoleOrigin?: string;
  /** How long a minted token is valid. Short: a preview link is not a share link. */
  ttlSeconds?: number;
}

export interface PreviewToken {
  /** The full URL the browser loads, on the preview origin, token embedded. */
  url: string;
  /** When the token stops working, epoch ms — surfaced so a UI can refresh. */
  expiresAt: number;
}

const DEFAULT_TTL_SECONDS = 300;

/**
 * Mints and verifies preview tokens, and decides the headers preview content is
 * served with. Deliberately separate from `ArtifactService`: the security of a
 * preview is entirely in these two decisions — who may load it, and what it may
 * do once loaded — and keeping them in one small, readable place is the point.
 */
export class PreviewService {
  readonly #clock: Clock;
  readonly #keys: KeyProvider;
  readonly #previewOrigin: string | undefined;
  readonly #consoleOrigin: string | undefined;
  readonly #ttlMs: number;

  constructor(options: PreviewOptions) {
    this.#clock = options.clock;
    this.#keys = options.keys;
    this.#previewOrigin = options.previewOrigin?.replace(/\/+$/, '');
    this.#consoleOrigin = options.consoleOrigin;
    this.#ttlMs = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
  }

  /** Whether preview is available at all — true only with a separate origin. */
  get enabled(): boolean {
    return this.#previewOrigin !== undefined;
  }

  /**
   * Mint a signed URL that renders one artifact on the preview origin.
   *
   * Throws when no separate origin is configured: there is no safe same-origin
   * preview, so the honest answer is that the feature is off, not a link that
   * would run agent code with the operator's session.
   */
  mint(artifactId: string): PreviewToken {
    if (this.#previewOrigin === undefined) {
      throw new MaError({
        code: 'PREVIEW_DISABLED',
        category: 'precondition',
        message:
          'Artifact preview is disabled: it requires a separate preview origin ' +
          '(MA_PREVIEW_ORIGIN) so agent-authored content cannot run with the console’s session.',
      });
    }
    const expiresAt = this.#clock.now() + this.#ttlMs;
    // A nonce makes two tokens for the same artifact-and-expiry distinct, so a
    // token is not a guessable function of public inputs.
    const nonce = newId('event', this.#clock.now());
    const signature = this.#sign(artifactId, expiresAt, nonce);
    const query = new URLSearchParams({
      exp: String(expiresAt),
      nonce,
      sig: signature,
    });
    return {
      url: `${this.#previewOrigin}/preview/v1/${artifactId}?${query.toString()}`,
      expiresAt,
    };
  }

  /**
   * Verify a token from a preview request. Returns true only for a signature
   * this service minted, over these exact values, that has not expired.
   */
  verify(artifactId: string, exp: number, nonce: string, signature: string): boolean {
    if (!Number.isFinite(exp) || exp < this.#clock.now()) return false;
    const expected = this.#sign(artifactId, exp, nonce);
    return safeEqual(expected, signature);
  }

  /**
   * The response headers preview content is served with.
   *
   * The CSP is the second layer behind the separate origin: `default-src 'none'`
   * so the content fetches nothing, `sandbox` so it runs with no privileges and
   * no same-origin identity, and `frame-ancestors` restricting who may embed it
   * to the console alone (or no one, if no console origin is configured). The
   * type is the sniffed one — never the agent's claim — so even here it is
   * something a browser renders rather than something arbitrary.
   */
  headers(contentType: string, sizeBytes: number): Record<string, string> {
    const frameAncestors = this.#consoleOrigin ? this.#consoleOrigin : "'none'";
    return {
      'content-type': contentType,
      'content-length': String(sizeBytes),
      'content-security-policy': `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox; frame-ancestors ${frameAncestors}`,
      'x-content-type-options': 'nosniff',
      // Even on the preview origin, an intermediary should not cache agent output.
      'cache-control': 'private, no-store',
      // No referrer leaks the token onward.
      'referrer-policy': 'no-referrer',
    };
  }

  #sign(artifactId: string, exp: number, nonce: string): string {
    const version = this.#keys.currentVersion();
    const key = this.#keys.keyFor(version);
    // The signing key is 32 raw bytes; hex-encode it for the string-keyed HMAC
    // helper. The signed material binds the token to one artifact and one
    // expiry, so a token cannot be replayed against a different artifact or past
    // its window.
    const secret = Buffer.from(key).toString('hex');
    return hmacSha256Hex(secret, `preview:${artifactId}:${exp}:${nonce}`);
  }
}
