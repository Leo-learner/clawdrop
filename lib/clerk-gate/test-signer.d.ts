import { type ClerkSessionClaims } from './clerk-gate.js';
export declare const TEST_PUBLISHABLE_KEY = "pk_test_Y2xlcmstZ2F0ZS50ZXN0JA";
export interface TestSigner {
    /** PEM public key to pass as jwtKey. */
    jwtKey: string;
    /** A signed token; `claims` override the defaults, `null` removes a claim. */
    token(claims?: Partial<Record<keyof ClerkSessionClaims, unknown>>, header?: Record<string, unknown>): string;
}
export declare function createTestSigner(defaults?: Partial<ClerkSessionClaims>): TestSigner;
