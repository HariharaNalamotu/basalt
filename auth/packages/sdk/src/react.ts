/**
 * Basalt Auth — React bindings.
 *
 *   <AuthProvider><App /></AuthProvider>
 *   const { user, loading, auth } = useAuth();
 *
 * `user` is null when signed out. Gate UI on it, but remember: hiding UI is not security.
 * Every protected action must also be checked on your backend with `auth.requireUser(req)`.
 */
import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createAuthClient, type AuthClient, type AuthClientOptions, type User } from './client.js';

export * from './client.js';

interface AuthState {
  user: User | null;
  loading: boolean;
  auth: AuthClient;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider(props: { children?: ReactNode; client?: AuthClient; options?: AuthClientOptions }) {
  const auth = useMemo(() => props.client ?? createAuthClient(props.options), [props.client]);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const off = auth.onChange((u) => active && setUser(u));
    auth
      .getUser()
      .then((u) => active && setUser(u))
      .catch(() => active && setUser(null))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      off();
    };
  }, [auth]);

  const value = useMemo(() => ({ user, loading, auth }), [user, loading, auth]);
  return createElement(Ctx.Provider, { value }, props.children);
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>.');
  return v;
}
