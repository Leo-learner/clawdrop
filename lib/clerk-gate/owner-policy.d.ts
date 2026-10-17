import type { ClerkSessionClaims } from './clerk-gate.js';
export type OwnerSite = 'nbd' | 'clawdrop' | 'plos' | 'unfortunately';
/**
 * Return true to let this owner session in, false to answer 403 "stale-session"
 * (the site then sends the owner to accounts.dkz12345.com to sign in again).
 *
 * claims.fva is [minutesSinceFirstFactor, minutesSinceSecondFactor]:
 *   - first factor  = password, email code, GitHub/Google, or passkey
 *   - second factor = authenticator app or backup code; -1 means no second
 *     factor was verified in this session (for example MFA is not set up)
 *   - fva can be missing if Clerk ever stops sending it; treat that as unknown.
 * Clerk ends any session after 7 days idle / 30 days total regardless.
 *
 * Every owner site requires both factors, with no single-factor fallback.
 * At the limit (60 minutes for nbd, 720 elsewhere), reverify both factors.
 * Missing/malformed factor ages or an unknown site fail closed.
 */
export declare function ownerSessionAcceptable(claims: ClerkSessionClaims, site: OwnerSite): boolean;
