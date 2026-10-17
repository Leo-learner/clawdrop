import { type OwnerSite } from './owner-policy.js';
export declare const CLERK_ISSUER = "https://clerk.dkz12345.com";
export declare const ACCOUNTS_URL = "https://accounts.dkz12345.com";
export interface ClerkSessionClaims {
    iss: string;
    sub: string;
    sid: string;
    azp?: string;
    iat: number;
    nbf: number;
    exp: number;
    /** Minutes since the first / second factor was verified; -1 = never in this session. */
    fva?: [number, number];
    email?: string | null;
    username?: string | null;
    name?: string | null;
    image?: string | null;
    [claim: string]: unknown;
}
export interface ClerkUser {
    id: string;
    sessionId: string;
    email: string | null;
    username: string | null;
    name: string | null;
    image: string | null;
}
export type SignedOutReason = 'missing' | 'invalid' | 'expired' | 'wrong-party' | 'wrong-issuer';
export type GateResult = {
    ok: true;
    user: ClerkUser;
    claims: ClerkSessionClaims;
    source: 'cookie' | 'bearer';
} | {
    ok: false;
    reason: SignedOutReason;
};
export type OwnerResult = {
    ok: true;
    user: ClerkUser;
    claims: ClerkSessionClaims;
} | {
    ok: false;
    status: 401;
    reason: SignedOutReason;
} | {
    ok: false;
    status: 403;
    reason: 'not-owner' | 'stale-session' | 'policy-error';
};
/** Node's IncomingHttpHeaders, or a Fetch `Headers`. */
export type HeaderSource = Record<string, string | string[] | undefined> | {
    get(name: string): string | null;
};
export interface GateOptions {
    /** pk_live_... (public). Used only to derive the suffixed cookie name. */
    publishableKey: string;
    /** PEM public key (CLERK_JWT_KEY). Never pass the secret key here. */
    jwtKey: string;
    /** This site's own origin(s), e.g. ['https://games.dkz12345.com']. */
    authorizedParties: string[];
    issuer?: string;
    clockSkewInMs?: number;
}
export interface OwnerOptions {
    ownerUserId: string;
    site: OwnerSite;
    /** Injected in tests; defaults to the shared owner policy. */
    policy?: (claims: ClerkSessionClaims, site: OwnerSite) => boolean;
}
export interface ClerkGate {
    /** Cookie names checked, most specific first. */
    readonly cookieNames: readonly string[];
    authenticate(headers: HeaderSource): Promise<GateResult>;
    verify(token: string): Promise<GateResult>;
    requireOwner(headers: HeaderSource, options: OwnerOptions): Promise<OwnerResult>;
}
export declare function cookieSuffix(publishableKey: string): string;
export declare function createClerkGate(options: GateOptions): ClerkGate;
