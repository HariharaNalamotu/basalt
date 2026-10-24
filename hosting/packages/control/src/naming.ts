import { APP_NAME_RE, type EnvKind } from '@basalt/host-shared';

export { APP_NAME_RE };

/**
 * One DNS label per environment (`app--staging.root`) so a single wildcard certificate covers
 * every environment (Cloudflare's universal certificate covers one level).
 */
export function hostFor(app: string, kind: EnvKind, slug: string, root: string) {
  if (kind === 'production') return `${app}.${root}`;
  return `${app}--${kind === 'staging' ? 'staging' : slug}.${root}`;
}

/** Key used for per-environment resources (databases, roles): `<app>-<slug>`. */
export const envKey = (app: string, slug: string) => `${app}-${slug}`;
export const networkName = (envId: string) => `basalt-env-${envId}`;
export const subnetFor = (index: number) => `10.201.${index}.0/24`;
export const imageTag = (app: string, deploymentId: string) => `basalt-app/${app}:${deploymentId}`;
export const RESERVED_APP_NAMES = new Set(['www', 'api', 'auth', 'host', 'registry', 'admin', 'mail', 'status', 'app', 'edge', 'internal', 'staging', 'preview', 'static', 'cdn', 'cloud']);

/**
 * Origins an app's pages sign in from. Always https. A one-laptop demo also serves apps over plain
 * http on a port (LOCAL_HTTP_PORT), so that origin is allowed too.
 */
export function appOrigins(host: string, localHttpPort?: number): string[] {
  return localHttpPort ? [`https://${host}`, `http://${host}:${localHttpPort}`] : [`https://${host}`];
}

/**
 * Whether an agent may read an environment's captured email. Test environments always. Production
 * email belongs to real customers and stays private, except on a one-laptop demo with no email
 * provider, where otherwise nobody could ever finish signing up.
 */
export function emailsReadable(kind: 'preview' | 'staging' | 'production', o: { localHttpPort?: number; resendKey?: string }): boolean {
  return kind !== 'production' || (Boolean(o.localHttpPort) && !o.resendKey);
}
