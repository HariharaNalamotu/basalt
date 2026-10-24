/**
 * Basalt Auth — browser client.
 *
 *   import { createAuthClient } from '@basalt/auth/client';
 *   export const auth = createAuthClient();
 *
 * Security model (you don't have to do anything for these):
 * - Session tokens live in HttpOnly cookies. JavaScript (including injected scripts) can never read them.
 * - Access tokens are refreshed automatically before they expire; refresh is serialized across tabs.
 * - Signing out in one tab signs out every tab.
 * Never store tokens, user ids or "isLoggedIn" flags in localStorage — ask `getUser()` instead.
 */
import { BasaltAuthError, toAuthError } from './errors.js';
import type { SessionInfo, User } from './types.js';

export { BasaltAuthError } from './errors.js';
export type { AuthErrorCode } from './errors.js';
export type { User, SessionInfo } from './types.js';

export interface AuthClientOptions {
  /**
   * Where the auth API is reachable from the browser. On Basalt the platform serves it on your app's
   * own origin at `/_basalt/auth`, which is the default — leave this unset.
   */
  baseUrl?: string;
  /** Custom fetch (tests, SSR). Must send cookies (credentials: 'include'). */
  fetch?: typeof fetch;
}

export type SignInResult = { status: 'signed_in'; user: User } | { status: 'mfa_required' };
export type SignUpResult = { status: 'verification_required' } | { status: 'signed_in'; user: User };
export type AuthChangeListener = (user: User | null) => void;

const SIGNUP_KEY = 'basalt_auth_signup';
const CHANNEL = 'basalt_auth';
const REFRESH_LEAD_MS = 60_000;

export interface AuthClient {
  /** The signed-in user, or null. Refreshes the session transparently if needed. */
  getUser(): Promise<User | null>;
  /** Subscribe to sign-in / sign-out (including from other tabs). Returns an unsubscribe function. */
  onChange(listener: AuthChangeListener): () => void;

  /** Starts sign-up. Usually returns `verification_required`: ask the user for the 6-digit emailed code, then call `verifySignUp`. */
  signUp(input: { email: string; password: string }): Promise<SignUpResult>;
  verifySignUp(input: { code: string }): Promise<{ status: 'signed_in'; user: User }>;
  resendSignUpCode(): Promise<void>;

  /** If this returns `mfa_required`, ask for an authenticator (or recovery) code and call `submitMfaCode`. */
  signIn(input: { email: string; password: string }): Promise<SignInResult>;
  submitMfaCode(input: { code: string }): Promise<{ status: 'signed_in'; user: User }>;
  signOut(): Promise<void>;
  /**
   * Re-confirm identity for a sensitive action (when your backend answers `reauthentication_required`).
   * Pass `code` too if the user has two-factor enabled (the error code is `mfa_required` otherwise).
   */
  reauthenticate(input: { password: string; code?: string }): Promise<{ status: 'signed_in'; user: User }>;

  /** For accounts created while email verification was off, or when sign-in returns `email_not_verified`. */
  verifyEmail(input: { email: string; code: string }): Promise<{ status: 'signed_in' | 'email_verified'; user: User }>;
  sendEmailVerification(): Promise<void>;

  requestPasswordReset(input: { email: string }): Promise<void>;
  /** Resets the password and signs out every session. The user then signs in with the new password. */
  resetPassword(input: { email: string; code: string; newPassword: string }): Promise<void>;
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<void>;

  mfa: {
    /** Show `otpauthUrl` as a QR code (and `secret` for manual entry), then call `confirm` with a code from the app. */
    enroll(): Promise<{ secret: string; otpauthUrl: string }>;
    /** Returns one-time recovery codes. Show them once and tell the user to store them safely. */
    confirm(input: { code: string }): Promise<{ recoveryCodes: string[] }>;
    disable(input: { password: string; code: string }): Promise<void>;
    regenerateRecoveryCodes(input: { code: string }): Promise<{ recoveryCodes: string[] }>;
  };

  sessions: {
    list(): Promise<SessionInfo[]>;
    revoke(sessionId: string): Promise<void>;
    revokeOthers(): Promise<{ revoked: number }>;
  };

  deleteAccount(input: { password: string }): Promise<void>;

  /**
   * `fetch` for calling YOUR backend. Sends the session cookie and, if the backend answers 401
   * because the access token just expired, refreshes once and retries.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

  /** Public project configuration (password length, whether MFA is enabled, app name). */
  getConfig(): Promise<{ appName: string; requireEmailVerification: boolean; passwordMinLength: number; allowTotp: boolean }>;
}

export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  const base = (options.baseUrl ?? '/_basalt/auth').replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const listeners = new Set<AuthChangeListener>();
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  let current: User | null | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<boolean> | null = null;
  let mfaToken: string | null = null;

  const storage = {
    get(): string | null {
      try {
        return globalThis.sessionStorage?.getItem(SIGNUP_KEY) ?? null;
      } catch {
        return null;
      }
    },
    set(v: string | null) {
      try {
        if (v === null) globalThis.sessionStorage?.removeItem(SIGNUP_KEY);
        else globalThis.sessionStorage?.setItem(SIGNUP_KEY, v);
      } catch {
        /* storage unavailable (private mode); sign-up must then be finished in this page */
      }
    },
  };
  let signupToken: string | null = storage.get();

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        credentials: 'include',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new BasaltAuthError('network_error', 'Could not reach the authentication service.', 0);
    }
    if (!res.ok) throw await toAuthError(res);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  function setUser(user: User | null, opts: { broadcast?: boolean; accessTokenExpiresAt?: string } = {}) {
    const changed = JSON.stringify(user) !== JSON.stringify(current);
    current = user;
    clearTimeout(refreshTimer);
    if (user && opts.accessTokenExpiresAt) scheduleRefresh(opts.accessTokenExpiresAt);
    if (changed) {
      for (const l of listeners) l(user);
      if (opts.broadcast !== false) channel?.postMessage({ type: user ? 'signed_in' : 'signed_out' });
    }
  }

  function scheduleRefresh(expiresAt: string) {
    const delay = Math.max(5_000, new Date(expiresAt).getTime() - Date.now() - REFRESH_LEAD_MS);
    refreshTimer = setTimeout(() => void refresh(), delay);
  }

  /** One refresh at a time per page, and per browser when Web Locks are available. */
  function refresh(): Promise<boolean> {
    refreshing ??= (async () => {
      const run = async () => {
        try {
          const r = await call<{ user: User; session: { accessTokenExpiresAt: string } }>('POST', '/session/refresh', {});
          setUser(r.user, { accessTokenExpiresAt: r.session.accessTokenExpiresAt });
          return true;
        } catch (err) {
          if (err instanceof BasaltAuthError && err.code === 'refresh_in_progress') {
            // Another tab won the race and already set fresh cookies.
            await new Promise((r) => setTimeout(r, 300));
            return loadSession();
          }
          if (err instanceof BasaltAuthError && (err.status === 401 || err.status === 403)) {
            setUser(null);
            return false;
          }
          throw err;
        }
      };
      const locks = (globalThis.navigator as Navigator | undefined)?.locks;
      return locks ? locks.request('basalt_auth_refresh', run) : run();
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function loadSession(): Promise<boolean> {
    try {
      const r = await call<{ user: User; session: { accessTokenExpiresAt: string } }>('GET', '/session');
      setUser(r.user, { accessTokenExpiresAt: r.session.accessTokenExpiresAt });
      return true;
    } catch (err) {
      if (err instanceof BasaltAuthError && err.status === 401) return false;
      throw err;
    }
  }

  channel?.addEventListener('message', (e: MessageEvent<{ type: string }>) => {
    if (e.data?.type === 'signed_out') setUser(null, { broadcast: false });
    if (e.data?.type === 'signed_in') {
      loadSession()
        .then((ok) => ok || refresh())
        .catch(() => {
          /* best effort: the next getUser() call will retry */
        });
    }
  });

  type SessionBody = { status: 'signed_in'; user: User; session: { accessTokenExpiresAt: string } };
  const accept = (r: SessionBody) => {
    setUser(r.user, { accessTokenExpiresAt: r.session.accessTokenExpiresAt });
    return { status: 'signed_in' as const, user: r.user };
  };

  const client: AuthClient = {
    async getUser() {
      if (current !== undefined) return current;
      if (await loadSession()) return current ?? null;
      if (await refresh()) return current ?? null;
      current = null;
      return null;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async signUp({ email, password }) {
      const r = await call<{ status: 'verification_required'; signupToken: string } | SessionBody>('POST', '/signup', { email, password });
      if (r.status === 'verification_required') {
        signupToken = r.signupToken;
        storage.set(signupToken);
        return { status: 'verification_required' };
      }
      return accept(r);
    },

    async verifySignUp({ code }) {
      if (!signupToken) throw new BasaltAuthError('invalid_request', 'No sign-up in progress. Call signUp first.', 400);
      const r = await call<SessionBody>('POST', '/signup/verify', { signupToken, code });
      signupToken = null;
      storage.set(null);
      return accept(r);
    },

    async resendSignUpCode() {
      if (!signupToken) throw new BasaltAuthError('invalid_request', 'No sign-up in progress. Call signUp first.', 400);
      await call('POST', '/signup/resend', { signupToken });
    },

    async signIn({ email, password }) {
      const r = await call<SessionBody | { status: 'mfa_required'; mfaToken: string }>('POST', '/signin', { email, password });
      if (r.status === 'mfa_required') {
        mfaToken = r.mfaToken;
        return { status: 'mfa_required' };
      }
      return accept(r);
    },

    async submitMfaCode({ code }) {
      if (!mfaToken) throw new BasaltAuthError('invalid_token', 'Sign-in expired. Please sign in again.', 401);
      try {
        const r = await call<SessionBody>('POST', '/signin/mfa', { mfaToken, code });
        mfaToken = null;
        return accept(r);
      } catch (err) {
        if (err instanceof BasaltAuthError && (err.code === 'invalid_token' || err.code === 'too_many_attempts')) mfaToken = null;
        throw err;
      }
    },

    async signOut() {
      clearTimeout(refreshTimer);
      try {
        await call('POST', '/session/signout', {});
      } finally {
        setUser(null);
      }
    },

    async reauthenticate({ password, code }) {
      return accept(await withRefresh(() => call<SessionBody>('POST', '/session/reauthenticate', { password, code })));
    },

    async verifyEmail({ email, code }) {
      const r = await call<SessionBody | { status: 'email_verified'; user: User }>('POST', '/email/verify', { email, code });
      if (r.status === 'email_verified') return r;
      return accept(r);
    },

    async sendEmailVerification() {
      await withRefresh(() => call('POST', '/email/verification/send', {}));
    },

    async requestPasswordReset({ email }) {
      await call('POST', '/password/reset/request', { email });
    },

    async resetPassword({ email, code, newPassword }) {
      await call('POST', '/password/reset/confirm', { email, code, newPassword });
      setUser(null);
    },

    async changePassword({ currentPassword, newPassword }) {
      await withRefresh(() => call('POST', '/password/change', { currentPassword, newPassword }));
    },

    mfa: {
      enroll: () => withRefresh(() => call('POST', '/mfa/totp/enroll', {})),
      async confirm({ code }) {
        const r = await withRefresh(() => call<{ recoveryCodes: string[] }>('POST', '/mfa/totp/confirm', { code }));
        if (current) setUser({ ...current, mfaEnabled: true });
        return r;
      },
      async disable({ password, code }) {
        await withRefresh(() => call('POST', '/mfa/totp/disable', { password, code }));
        if (current) setUser({ ...current, mfaEnabled: false });
      },
      regenerateRecoveryCodes: ({ code }) => withRefresh(() => call('POST', '/mfa/recovery-codes', { code })),
    },

    sessions: {
      list: async () => (await withRefresh(() => call<{ sessions: SessionInfo[] }>('GET', '/sessions'))).sessions,
      revoke: async (id) => {
        await withRefresh(() => call('DELETE', `/sessions/${encodeURIComponent(id)}`));
      },
      revokeOthers: () => withRefresh(() => call('POST', '/sessions/revoke-others', {})),
    },

    async deleteAccount({ password }) {
      await withRefresh(() => call('POST', '/account/delete', { password }));
      setUser(null);
    },

    async fetch(input, init = {}) {
      const send = () => doFetch(input, { ...init, credentials: init.credentials ?? 'same-origin' });
      const res = await send();
      if (res.status !== 401) return res;
      // Only retry requests whose body can be re-sent.
      if (init.body instanceof ReadableStream) return res;
      return (await refresh()) ? send() : res;
    },

    getConfig: () => call('GET', '/config'),
  };

  /** Runs `fn`; if the access token had expired (401), refreshes once and retries. */
  async function withRefresh<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BasaltAuthError && err.code === 'unauthenticated' && (await refresh())) return fn();
      throw err;
    }
  }

  return client;
}
