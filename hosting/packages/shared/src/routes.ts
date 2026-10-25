/**
 * The contract between the control plane (which decides) and the edge (which enforces).
 * The control plane publishes the full table; the edge polls it and never guesses.
 */
export type EnvKind = 'preview' | 'staging' | 'production';

export interface AppRoute {
  kind: 'app';
  host: string;
  app: string;
  envId: string;
  env: EnvKind;
  /** Auth project serving /_basalt/auth/* for this environment. */
  projectId: string;
  /** HMAC key the edge uses to sign requests to this environment's backend. */
  edgeSecret: string;
  /** Absolute path of the built static frontend, or null for API-only apps. */
  staticDir: string | null;
  /** Backend upstream (container on the environment's private network), or null. */
  backend: string | null;
  /** Stopped to save resources; the edge asks the control plane to wake it on demand. */
  sleeping: boolean;
  /** Non-production environments require a signed access token (cookie or header). */
  accessKey: string | null;
  protection: ProtectionSettings;
  /** Extra CSP sources the app needs (e.g. connect-src https://api.stripe.com). Validated by the control plane. */
  csp: CspSettings;
  /**
   * This environment's Data project on Basalt Cloud (like http://cloud:8790/p/<id>), served on
   * the app's own site at /_basalt/data so the signed-in session cookie reaches it. Null: none.
   */
  dataUrl: string | null;
  /**
   * Client IP buckets (see ipBucket) the app's owner always lets through: never banned, never
   * rate limited on this app. The WAF still refuses each malicious request and records it.
   */
  allowIps?: string[];
}

export interface ProtectionSettings {
  /** Requests per minute per client IP for this app. */
  perIpPerMinute: number;
  /** Max concurrent requests to the backend for this app (bulkhead). */
  maxConcurrency: number;
  /** Proof-of-work browser challenge before serving the app. */
  underAttack: boolean;
  /** Max request body accepted by the edge, bytes. */
  maxBodyBytes: number;
}

export interface CspSettings {
  connectSrc: string[];
  scriptSrc: string[];
  imgSrc: string[];
  styleSrc: string[];
  fontSrc: string[];
  frameSrc: string[];
}

export interface ServiceRoute {
  kind: 'service';
  host: string;
  /** Upstream base URL on the platform network. */
  upstream: string;
  /** Methods allowed through (e.g. read-only registry). */
  methods: string[];
  perIpPerMinute: number;
}

export type Route = AppRoute | ServiceRoute;

export interface RouteTable {
  version: number;
  generatedAt: string;
  /** Global switch: challenge every HTML navigation on every app. */
  underAttack: boolean;
  routes: Route[];
}

export const DEFAULT_PROTECTION: ProtectionSettings = {
  perIpPerMinute: 600,
  maxConcurrency: 64,
  underAttack: false,
  maxBodyBytes: 10 * 1024 * 1024,
};

export const EMPTY_CSP: CspSettings = { connectSrc: [], scriptSrc: [], imgSrc: [], styleSrc: [], fontSrc: [], frameSrc: [] };
