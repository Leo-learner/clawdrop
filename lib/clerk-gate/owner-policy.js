// Both factors must be younger than this limit. NBD holds private journal
// entries; the other owner sites allow a working day's access after MFA.
const MAX_FACTOR_AGE_MINUTES = {
    nbd: 60,
    clawdrop: 12 * 60,
    plos: 12 * 60,
    unfortunately: 12 * 60,
};
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
export function ownerSessionAcceptable(claims, site) {
    if (!Object.hasOwn(MAX_FACTOR_AGE_MINUTES, site))
        return false;
    const ages = claims.fva;
    if (!Array.isArray(ages) || ages.length !== 2)
        return false;
    const maxAge = MAX_FACTOR_AGE_MINUTES[site];
    // Use a dense pair so sparse/missing array entries are checked as well.
    return [ages[0], ages[1]].every(age => Number.isSafeInteger(age) && age >= 0 && age < maxAge);
}
