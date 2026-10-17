// Shared Clerk session check for the dkz12345.com sites.
//
// Verifies the short-lived Clerk session token (the `__session` cookie or a
// Bearer header) against the instance's PEM public key, without the Clerk
// secret key and without a network call. Each site vendors a copy of this
// directory; edit the original in ~/Desktop/01-项目/clerk-gate and re-sync.
import { createHash } from 'node:crypto';
import { verifyToken } from '@clerk/backend';
import { ownerSessionAcceptable } from './owner-policy.js';
export const CLERK_ISSUER = 'https://clerk.dkz12345.com';
export const ACCOUNTS_URL = 'https://accounts.dkz12345.com';
// Same derivation as @clerk/shared's getCookieSuffix: first 8 chars of the
// URL-safe base64 SHA-1 of the publishable key.
export function cookieSuffix(publishableKey) {
    return createHash('sha1')
        .update(publishableKey)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .substring(0, 8);
}
function readHeader(headers, name) {
    if (typeof headers.get === 'function') {
        return headers.get(name) ?? undefined;
    }
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
}
function readCookie(cookieHeader, name) {
    if (!cookieHeader)
        return undefined;
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1 || part.slice(0, eq).trim() !== name)
            continue;
        const raw = part.slice(eq + 1).trim();
        try {
            return decodeURIComponent(raw);
        }
        catch {
            return raw;
        }
    }
    return undefined;
}
function textClaim(value) {
    return typeof value === 'string' && value !== '' ? value : null;
}
function signedOutReason(error) {
    const reason = error?.reason;
    if (reason === 'token-expired')
        return 'expired';
    if (reason === 'token-invalid-authorized-parties')
        return 'wrong-party';
    return 'invalid';
}
export function createClerkGate(options) {
    const { publishableKey, jwtKey, authorizedParties } = options;
    const issuer = options.issuer ?? CLERK_ISSUER;
    if (!publishableKey || !jwtKey)
        throw new Error('clerk-gate: publishableKey and jwtKey are required');
    if (!jwtKey.includes('BEGIN PUBLIC KEY'))
        throw new Error('clerk-gate: jwtKey must be a PEM public key');
    if (authorizedParties.length === 0)
        throw new Error('clerk-gate: authorizedParties must list this site\'s origin');
    const cookieNames = [`__session_${cookieSuffix(publishableKey)}`, '__session'];
    async function verify(token) {
        let claims;
        try {
            // Throws a TokenVerificationError (bad signature, expired, wrong azp...).
            claims = (await verifyToken(token, {
                jwtKey,
                authorizedParties,
                clockSkewInMs: options.clockSkewInMs,
            }));
        }
        catch (error) {
            return { ok: false, reason: signedOutReason(error) };
        }
        if (claims.iss !== issuer)
            return { ok: false, reason: 'wrong-issuer' };
        if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string')
            return { ok: false, reason: 'invalid' };
        return {
            ok: true,
            claims,
            source: 'cookie',
            user: {
                id: claims.sub,
                sessionId: claims.sid,
                email: textClaim(claims.email),
                username: textClaim(claims.username),
                name: textClaim(claims.name),
                image: textClaim(claims.image),
            },
        };
    }
    async function authenticate(headers) {
        const authorization = readHeader(headers, 'authorization');
        const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
        if (bearer) {
            const result = await verify(bearer);
            return result.ok ? { ...result, source: 'bearer' } : result;
        }
        const cookieHeader = readHeader(headers, 'cookie');
        for (const name of cookieNames) {
            const token = readCookie(cookieHeader, name);
            if (token)
                return verify(token);
        }
        return { ok: false, reason: 'missing' };
    }
    async function requireOwner(headers, { ownerUserId, site, policy = ownerSessionAcceptable }) {
        if (!ownerUserId?.startsWith('user_'))
            throw new Error('clerk-gate: ownerUserId must be a Clerk user id');
        const result = await authenticate(headers);
        if (!result.ok)
            return { ok: false, status: 401, reason: result.reason };
        if (result.user.id !== ownerUserId)
            return { ok: false, status: 403, reason: 'not-owner' };
        let acceptable;
        try {
            acceptable = policy(result.claims, site) === true;
        }
        catch {
            return { ok: false, status: 403, reason: 'policy-error' };
        }
        if (!acceptable)
            return { ok: false, status: 403, reason: 'stale-session' };
        return { ok: true, user: result.user, claims: result.claims };
    }
    return { cookieNames, authenticate, verify, requireOwner };
}
