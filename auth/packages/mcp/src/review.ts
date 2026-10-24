/**
 * Static review for the auth mistakes coding agents most often make. Deliberately pattern-based
 * and fast: it is a guard rail run on every auth-related change, not a full SAST tool.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  rule: string;
  severity: Severity;
  line: number;
  snippet: string;
  problem: string;
  fix: string;
}

interface Rule {
  id: string;
  severity: Severity;
  pattern: RegExp;
  /** Only applies when the file looks like browser code. */
  clientOnly?: boolean;
  problem: string;
  fix: string;
}

const RULES: Rule[] = [
  {
    id: 'hardcoded-secret-key',
    severity: 'critical',
    pattern: /bslt_sk_[A-Za-z0-9_-]{8,}/,
    problem: 'A Basalt Auth secret key is hardcoded in source code.',
    fix: 'Delete it, rotate it with the auth_rotate_secret_key tool, and read it from the BASALT_AUTH_SECRET_KEY environment variable on the backend only.',
  },
  {
    id: 'secret-key-public-env',
    severity: 'critical',
    pattern: /(NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|PUBLIC_)[A-Z_]*SECRET/,
    problem: 'A secret is exposed through a public (browser-bundled) environment variable prefix.',
    fix: 'Secrets must never use NEXT_PUBLIC_/VITE_/REACT_APP_/EXPO_PUBLIC_ prefixes. Keep BASALT_AUTH_SECRET_KEY server-side only.',
  },
  {
    id: 'secret-key-in-client',
    severity: 'critical',
    pattern: /BASALT_AUTH_SECRET_KEY|secretKey\s*:/,
    clientOnly: true,
    problem: 'Browser code references the project secret key.',
    fix: 'Browser code uses `createAuthClient()` from @basalt/auth/client, which needs no keys. Move admin operations to your backend.',
  },
  {
    id: 'server-sdk-in-client',
    severity: 'high',
    pattern: /from\s+['"]@basalt\/auth\/server['"]/,
    clientOnly: true,
    problem: 'The server SDK is imported in browser code.',
    fix: "Use '@basalt/auth/client' (or '@basalt/auth/react') in the browser; '@basalt/auth/server' belongs in backend code only.",
  },
  {
    id: 'token-in-web-storage',
    severity: 'high',
    pattern: /(localStorage|sessionStorage)\s*\.\s*setItem\s*\(\s*[^,]*(token|jwt|session|auth|user_?id|logged)/i,
    problem: 'Auth state is being written to web storage, where any injected script can read or forge it.',
    fix: 'Remove it. Sessions live in HttpOnly cookies managed by the SDK; call `auth.getUser()` / `useAuth()` to know who is signed in.',
  },
  {
    id: 'document-cookie-auth',
    severity: 'high',
    pattern: /document\.cookie[^;\n]*(token|session|auth|basalt)/i,
    problem: 'Code reads or writes auth cookies from JavaScript.',
    fix: 'Auth cookies are HttpOnly and invisible to JS by design. Use the SDK instead.',
  },
  {
    id: 'manual-authorization-header',
    severity: 'medium',
    pattern: /['"]?authorization['"]?\s*:\s*[`'"]Bearer\s*\$?\{?/i,
    clientOnly: true,
    problem: 'Browser code builds an Authorization header by hand, which implies a token is reachable from JS.',
    fix: 'Use `auth.fetch(url, init)` from the client SDK. It sends the HttpOnly session cookie and refreshes automatically.',
  },
  {
    id: 'jwt-decode-without-verify',
    severity: 'high',
    pattern: /\b(jwt\.decode|jwtDecode|jwt_decode|decodeJwt|parseJwt)\s*\(|atob\s*\(\s*\w+\.split\(['"]\.['"]\)/,
    problem: 'A JWT is decoded without verifying its signature. Anyone can forge the contents.',
    fix: 'On the backend use `await auth.getUser(req)` / `auth.requireUser(req)`, which verify signature, issuer, audience and expiry.',
  },
  {
    id: 'own-jwt-signing',
    severity: 'high',
    pattern: /from\s+['"]jsonwebtoken['"]|require\(\s*['"]jsonwebtoken['"]\s*\)|\bjwt\.sign\s*\(|new\s+SignJWT\s*\(/,
    problem: 'The app signs its own tokens, creating a second, unaudited auth system.',
    fix: 'Remove it. Basalt Auth issues and verifies all session tokens.',
  },
  {
    id: 'own-password-hashing',
    severity: 'high',
    pattern: /\b(bcrypt|bcryptjs|argon2|scrypt|pbkdf2)\b|createHash\(\s*['"](md5|sha1|sha256|sha512)['"]\s*\)[^;\n]*pass/i,
    problem: 'The app hashes passwords itself.',
    fix: 'Never handle passwords in app code. Basalt Auth stores and verifies them (Argon2id). Remove the password logic and use the SDK sign-up/sign-in calls.',
  },
  {
    id: 'password-column',
    severity: 'high',
    pattern: /\b(password|password_hash|passwordHash|hashed_password)\b\s*(:|\s)\s*(text|varchar|string|String|char|z\.string|@Column|t\.string|column\.text)/i,
    problem: 'The app schema stores passwords.',
    fix: 'Drop the column. Link your tables to Basalt users with `user_id uuid` (the `user.id` from the SDK) and nothing else.',
  },
  {
    id: 'competing-auth-library',
    severity: 'medium',
    pattern: /from\s+['"](next-auth|@auth\/core|passport[\w-]*|lucia|express-session|cookie-session|iron-session|@clerk\/[\w-]+|@supabase\/auth-helpers[\w-]*|firebase\/auth)['"]/,
    problem: 'A second auth/session library is in use alongside Basalt Auth.',
    fix: 'Remove it and use @basalt/auth for every sign-in, session and user check. Two auth systems double the attack surface.',
  },
  {
    id: 'client-supplied-user-id',
    severity: 'high',
    pattern: /\breq\.(body|query|params)\.(userId|user_id|ownerId|owner_id|uid|accountId)\b|\b(body|searchParams|params)\.(get\(['"])?(userId|user_id|ownerId|owner_id)\b/,
    problem: 'A user/owner id is taken from the request. Any user can put someone else\'s id there (IDOR).',
    fix: 'Use the verified id: `const user = await auth.requireUser(req); ... user.id`. Only admin routes (checked server-side) may act on other users.',
  },
  {
    id: 'client-supplied-role',
    severity: 'high',
    pattern: /\breq\.(body|query|headers)\.(role|isAdmin|is_admin|admin|permissions)\b/,
    problem: 'Authorization is decided from client-supplied data.',
    fix: 'Look roles up server-side from your database (keyed by `user.id`) or from user metadata via `auth.admin.getUser(user.id)`.',
  },
  {
    id: 'permissive-credentialed-cors',
    severity: 'high',
    pattern: /cors\(\s*\{[^}]*origin\s*:\s*(true|['"]\*['"])[^}]*credentials\s*:\s*true|cors\(\s*\{[^}]*credentials\s*:\s*true[^}]*origin\s*:\s*(true|['"]\*['"])/s,
    problem: 'CORS reflects any origin with credentials, letting any website act as the signed-in user.',
    fix: 'On Basalt the frontend and API share an origin, so remove CORS. If you truly need it, list exact origins.',
  },
  {
    id: 'insecure-randomness',
    severity: 'high',
    pattern: /Math\.random\(\)[^;\n]*(token|code|otp|secret|nonce|password|key)|(token|code|otp|secret|nonce|password|key)\w*\s*=\s*[^;\n]*Math\.random\(\)/i,
    problem: 'Math.random() is used for a security value; it is predictable.',
    fix: 'Use crypto.randomUUID() / crypto.getRandomValues(), or better, let Basalt Auth generate codes and tokens.',
  },
  {
    id: 'unsafe-html',
    severity: 'medium',
    pattern: /dangerouslySetInnerHTML|\.innerHTML\s*=(?!\s*['"`]\s*['"`])/,
    problem: 'Raw HTML injection enables XSS, which can act as the signed-in user.',
    fix: 'Render text normally. If HTML is unavoidable, sanitize it with DOMPurify first.',
  },
  {
    id: 'auth-check-ignored',
    severity: 'medium',
    pattern: /^\s*(await\s+)?auth\.getUser\([^)]*\)\s*;?\s*$/,
    problem: '`auth.getUser()` is called but its result is discarded, so the route is not actually protected.',
    fix: 'Use `const user = await auth.requireUser(req)` (throws 401 when signed out), or check `if (!user)` and return 401.',
  },
];

const CLIENT_HINTS = /['"]use client['"]|from\s+['"]react['"]|from\s+['"]@basalt\/auth\/(client|react)['"]|\bdocument\.|\bwindow\./;
const CLIENT_PATH = /(^|\/)(src\/(components|pages|hooks|app\/.*\.client)|components|client|frontend|web|public)\/|\.(tsx|jsx|vue|svelte)$/;
const SERVER_HINTS = /['"]use server['"]|from\s+['"]@basalt\/auth\/server['"]|from\s+['"](express|hono|fastify|next\/server|node:)|server-only/;

export function looksLikeClientCode(code: string, filename?: string): boolean {
  // An explicit directive is decisive; a client file importing server code is exactly what we want to catch.
  if (/^\s*['"]use client['"]/m.test(code)) return true;
  if (SERVER_HINTS.test(code)) return false;
  return CLIENT_HINTS.test(code) || (filename !== undefined && CLIENT_PATH.test(filename));
}

export function reviewCode(code: string, filename?: string): Finding[] {
  const isClient = looksLikeClientCode(code, filename);
  const lines = code.split('\n');
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (rule.clientOnly && !isClient) continue;
    if (rule.pattern.flags.includes('s')) {
      const m = rule.pattern.exec(code);
      if (m) {
        const line = code.slice(0, m.index).split('\n').length;
        findings.push(toFinding(rule, line, lines[line - 1] ?? ''));
      }
      continue;
    }
    lines.forEach((text, i) => {
      if (rule.pattern.test(text)) findings.push(toFinding(rule, i + 1, text));
    });
  }
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
}

function toFinding(rule: Rule, line: number, text: string): Finding {
  // Never echo a full secret back into the agent transcript.
  const snippet = text.trim().replace(/bslt_sk_[A-Za-z0-9_-]+/g, 'bslt_sk_[REDACTED]').slice(0, 200);
  return { rule: rule.id, severity: rule.severity, line, snippet, problem: rule.problem, fix: rule.fix };
}
