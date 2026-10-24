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
 * Whether an agent may read an environment's captured email. Test environments always. Production
 * email belongs to real customers and stays private, except on a one-laptop demo (served over plain
 * http) with no email provider, where otherwise nobody could ever finish signing up.
 */
export function emailsReadable(kind: 'preview' | 'staging' | 'production', o: { localDemo: boolean; resendKey?: string }): boolean {
  return kind !== 'production' || (o.localDemo && !o.resendKey);
}
