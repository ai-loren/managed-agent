/**
 * SCIM 2.0 provisioning routes.
 *
 * A separate auth surface, like runtime and ingress: an IdP authenticates with a
 * dedicated SCIM bearer token, not a principal's API key, so the two auth models
 * never mix. Every handler authorises that token (constant-time, in the service)
 * before doing anything, and the paths are whitelisted out of the principal
 * bearer middleware in `server.ts`.
 *
 * The routes are a thin HTTP shell over `ScimService`: parse the request, call
 * the service, map a `ScimError` to its HTTP status with the SCIM error body an
 * IdP expects. All the provisioning logic — convergence with OIDC, token
 * revocation on deactivate — lives in the service.
 */

import type { ScimService } from '@ma/engine';
import { ScimError } from '@ma/engine';

import type { Router, RequestContext, HandlerResult } from './router.ts';

const PREFIX = '/scim/v2';
const SCIM_CONTENT_TYPE = 'application/scim+json';

/** True for a path the principal bearer middleware must skip (SCIM has its own). */
export function isScimPath(path: string): boolean {
  return path.startsWith(`${PREFIX}/`);
}

export interface ScimRoutesDeps {
  scim: ScimService;
}

export function registerScimRoutes(router: Router, deps: ScimRoutesDeps): void {
  const { scim } = deps;

  /** Authorise, then run `fn`, mapping ScimError to the SCIM error body. */
  const guarded = (
    fn: (context: RequestContext) => Promise<HandlerResult>,
  ) => async (context: RequestContext): Promise<HandlerResult> => {
    try {
      scim.authorize(bearer(context));
      return await fn(context);
    } catch (error) {
      if (error instanceof ScimError) {
        return { status: error.status, headers: scimHeaders(), body: error.body() };
      }
      throw error;
    }
  };

  router.post(`${PREFIX}/Users`, guarded(async (context) => {
    const { user, created } = await scim.createUser(context.body);
    return { status: created ? 201 : 200, headers: scimHeaders(), body: user };
  }));

  router.get(`${PREFIX}/Users`, guarded(async (context) => {
    const list = await scim.listUsers(context.query);
    return { status: 200, headers: scimHeaders(), body: list };
  }));

  router.get(`${PREFIX}/Users/:id`, guarded(async (context) => {
    const user = await scim.getUser(context.params.id!);
    return { status: 200, headers: scimHeaders(), body: user };
  }));

  router.put(`${PREFIX}/Users/:id`, guarded(async (context) => {
    const user = await scim.replaceUser(context.params.id!, context.body);
    return { status: 200, headers: scimHeaders(), body: user };
  }));

  router.patch(`${PREFIX}/Users/:id`, guarded(async (context) => {
    const user = await scim.patchUser(context.params.id!, context.body);
    return { status: 200, headers: scimHeaders(), body: user };
  }));

  router.delete(`${PREFIX}/Users/:id`, guarded(async (context) => {
    await scim.deleteUser(context.params.id!);
    return { status: 204, headers: scimHeaders() };
  }));
}

function bearer(context: RequestContext): string | undefined {
  const header = context.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim();
}

function scimHeaders(): Record<string, string> {
  return { 'content-type': SCIM_CONTENT_TYPE, 'cache-control': 'no-store' };
}
