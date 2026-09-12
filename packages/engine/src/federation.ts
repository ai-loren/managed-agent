/**
 * The federated-identity subject format.
 *
 * A single function owns the string that joins an external identity to a
 * platform principal, because two subsystems depend on it agreeing exactly:
 * OIDC login (which matches an incoming token's `sub`) and SCIM provisioning
 * (which the IdP drives ahead of, and after, that login). If they built the
 * string differently a SCIM-provisioned user and their later login would land on
 * two different principals — so the format lives here, imported by both, and can
 * never drift.
 *
 *   oidc:<providerId>:<externalId>
 *
 * Namespaced by provider so two IdPs that happen to use the same opaque id never
 * collapse into one principal, and one provider can never assert an identity that
 * belongs to another. SCIM uses the same `oidc:` namespace (not a separate
 * `scim:` one) precisely so it converges with login: the IdP's SCIM `externalId`
 * is the same stable user id it later asserts as the token `sub`.
 */
export function federatedSubject(providerId: string, externalId: string): string {
  return `oidc:${providerId}:${externalId}`;
}
