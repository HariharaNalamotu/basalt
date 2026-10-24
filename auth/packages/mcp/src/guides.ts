/**
 * Integration guides served to coding agents. Every snippet here is the *complete* correct
 * pattern — agents should copy it rather than improvise. Keep in sync with packages/sdk.
 */

export const FRAMEWORKS = ['react', 'nextjs', 'express', 'hono', 'native'] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const RULES = `## Non-negotiable rules for apps using Basalt Auth

1. **Never build auth yourself.** No password columns, no password hashing, no JWT signing, no session tables, no reset-token logic, no "remember me" cookies. Basalt Auth does all of it. Do not add next-auth, passport, lucia, express-session or jsonwebtoken alongside it.
2. **Never touch tokens in frontend code.** Sessions are HttpOnly cookies; the SDK manages them. Never put tokens, user ids or "isLoggedIn" flags in localStorage/sessionStorage/document.cookie. Ask \`auth.getUser()\` instead.
3. **Every backend route that reads or writes user data calls \`auth.requireUser(req)\`** and scopes database queries by \`user.id\` (e.g. \`WHERE owner_id = $user.id\`). Never trust a user id, email or role sent by the client.
4. **Hiding UI is not security.** A button hidden for non-admins must also be rejected by the backend.
5. **The secret key (\`BASALT_AUTH_SECRET_KEY\`) is backend-only.** Never import it in frontend code, never prefix it with NEXT_PUBLIC_/VITE_, never commit or log it.
6. **Roles/permissions:** store them in your own database keyed by \`user.id\`, or in user \`metadata\` set from the backend via \`auth.admin.updateUser\`. Users cannot edit metadata themselves.
7. **High-stakes actions** (payments, deleting data, changing roles) use \`auth.requireUser(req, { strict: true })\` so revoked sessions are rejected instantly. Admin panels also pass \`{ mfa: true }\`.
8. **Show the SDK's error messages as-is.** \`err.message\` is written for end users and never leaks whether an email is registered. Switch on \`err.code\` for flow control.
9. **Every origin that serves the frontend must be in the project's allowedOrigins** (production domain(s) and e.g. http://localhost:5173 for dev). Use the \`auth_update_project\` tool.
10. **Your own HTML must not allow XSS** (no \`dangerouslySetInnerHTML\`/\`innerHTML\` with user content): XSS can act as the user even though it can't steal the session.
`;

const ENV = `## Environment variables

Backend (set by the platform / \`auth_create_project\`):
- \`BASALT_PROJECT_ID\` — public project id (\`prj_...\`)
- \`BASALT_AUTH_URL\` — auth service URL
- \`BASALT_AUTH_SECRET_KEY\` — **secret**, backend only, only needed for \`auth.admin.*\` and \`{ strict: true }\`

Frontend: nothing. The browser talks to \`/_basalt/auth\` on your own origin (the platform routes it).
For local dev without the platform edge, pass \`createAuthClient({ baseUrl: \`\${BASALT_AUTH_URL}/v1/projects/\${BASALT_PROJECT_ID}\` })\` — that value is public, not a secret.
`;

const REACT = `# Basalt Auth — React (Vite/SPA) integration

\`\`\`bash
npm install @basalt/auth
\`\`\`

### 1. One client for the whole app — \`src/auth.ts\`
\`\`\`ts
import { createAuthClient } from '@basalt/auth/client';
export const auth = createAuthClient();
\`\`\`

### 2. Provide it — \`src/main.tsx\`
\`\`\`tsx
import { AuthProvider } from '@basalt/auth/react';
import { auth } from './auth';

createRoot(document.getElementById('root')!).render(
  <AuthProvider client={auth}>
    <App />
  </AuthProvider>,
);
\`\`\`

### 3. Read the user anywhere
\`\`\`tsx
import { useAuth } from '@basalt/auth/react';

function Header() {
  const { user, loading, auth } = useAuth();
  if (loading) return null;
  return user ? <button onClick={() => auth.signOut()}>Sign out {user.email}</button> : <a href="/signin">Sign in</a>;
}
\`\`\`

### 4. Sign up (two steps: form → emailed 6-digit code)
\`\`\`tsx
import { BasaltAuthError } from '@basalt/auth/client';

function SignUp() {
  const { auth } = useAuth();
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await auth.signUp({ email, password });
      if (r.status === 'verification_required') setStep('code');
      // r.status === 'signed_in' only when the project disabled email verification
    } catch (err) {
      setError(err instanceof BasaltAuthError ? err.message : 'Something went wrong.');
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await auth.verifySignUp({ code });
      navigate('/'); // signed in
    } catch (err) {
      setError(err instanceof BasaltAuthError ? err.message : 'Something went wrong.');
    }
  }

  return step === 'form' ? (
    <form onSubmit={submitForm}>
      <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && <p role="alert">{error}</p>}
      <button>Create account</button>
    </form>
  ) : (
    <form onSubmit={submitCode}>
      <p>We emailed a 6-digit code to {email}.</p>
      <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
      {error && <p role="alert">{error}</p>}
      <button>Verify</button>
      <button type="button" onClick={() => auth.resendSignUpCode()}>Resend code</button>
    </form>
  );
}
\`\`\`

### 5. Sign in (handles MFA and unverified email)
\`\`\`tsx
async function submit() {
  try {
    const r = await auth.signIn({ email, password });
    if (r.status === 'mfa_required') return setStep('mfa'); // then: await auth.submitMfaCode({ code })
    navigate('/');
  } catch (err) {
    if (err instanceof BasaltAuthError && err.code === 'email_not_verified') return setStep('verify-email'); // then: await auth.verifyEmail({ email, code })
    setError(err instanceof BasaltAuthError ? err.message : 'Something went wrong.');
  }
}
\`\`\`
\`submitMfaCode\` accepts a 6-digit authenticator code or a recovery code (\`xxxxx-xxxxx\`).
Use \`autoComplete="current-password"\` on the password field.

### 6. Forgot password
\`\`\`ts
await auth.requestPasswordReset({ email });            // always succeeds (doesn't reveal if the account exists)
await auth.resetPassword({ email, code, newPassword }); // signs out all sessions; then send the user to sign in
\`\`\`

### 7. Call YOUR backend
\`\`\`ts
const res = await auth.fetch('/api/todos', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title }),
});
\`\`\`
\`auth.fetch\` sends the session cookie and transparently refreshes an expired session once. Never add an Authorization header yourself in browser code. Protect the backend with the **express**, **hono** or **nextjs** guide.

### 8. Account settings (optional)
\`\`\`ts
await auth.changePassword({ currentPassword, newPassword }); // signs out other devices
const { otpauthUrl, secret } = await auth.mfa.enroll();      // render otpauthUrl as a QR code (e.g. 'qrcode' package), show secret for manual entry
const { recoveryCodes } = await auth.mfa.confirm({ code });  // show ONCE, ask the user to save them
await auth.mfa.disable({ password, code });
const sessions = await auth.sessions.list();                  // "where you're signed in"
await auth.sessions.revokeOthers();
await auth.deleteAccount({ password });
\`\`\`

### Route guard
\`\`\`tsx
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user ? <>{children}</> : <Navigate to="/signin" replace />;
}
\`\`\`
This is UX only. The backend must still call \`requireUser\`.
`;

const EXPRESS = `# Basalt Auth — Express backend

\`\`\`bash
npm install @basalt/auth
\`\`\`

\`\`\`ts
import express from 'express';
import { createAuthServer, BasaltAuthError } from '@basalt/auth/server';

const auth = createAuthServer(); // reads BASALT_PROJECT_ID, BASALT_AUTH_URL, BASALT_AUTH_SECRET_KEY
const app = express();
app.use(express.json());

// Protect every route under /api. req.auth is the verified user.
app.use('/api', auth.middleware({ required: true }));

app.get('/api/todos', async (req, res) => {
  const todos = await db.query('SELECT * FROM todos WHERE owner_id = $1', [req.auth.id]); // ALWAYS scope by req.auth.id
  res.json(todos.rows);
});

app.post('/api/todos', async (req, res) => {
  // Never take owner/user ids from req.body — use req.auth.id.
  const row = await db.query('INSERT INTO todos (owner_id, title) VALUES ($1, $2) RETURNING *', [req.auth.id, req.body.title]);
  res.status(201).json(row.rows[0]);
});

// High-stakes: instant revocation check + require MFA for admins.
// Admin routes are the ONLY place a target user id may come from the request, and only after the role check.
app.post('/api/admin/users/:targetUserId/ban', async (req, res, next) => {
  try {
    const admin = await auth.requireUser(req, { strict: true, mfa: true });
    if (!(await isAdmin(admin.id))) return res.status(403).json({ error: 'forbidden' }); // role from YOUR db
    await auth.admin.updateUser(req.params.targetUserId, { disabled: true });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof BasaltAuthError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    next(err);
  }
});
\`\`\`

For routes that work signed-in *or* signed-out use \`auth.middleware()\` (no \`required\`) — then \`req.auth\` is the user or \`null\`.

TypeScript: \`declare global { namespace Express { interface Request { auth: import('@basalt/auth/server').AuthUser | null } } }\`

Do **not** add \`cors()\` with \`credentials: true\` and a reflected/wildcard origin. On Basalt the frontend and API share an origin, so you need no CORS at all.

### Linking your data to users
Use \`user.id\` (a UUID) as the foreign key, e.g. \`owner_id uuid NOT NULL\`. Don't key on email (users can change it) and don't copy passwords or tokens into your database.
`;

const HONO = `# Basalt Auth — Hono backend

\`\`\`ts
import { Hono } from 'hono';
import { createAuthServer, type AuthUser } from '@basalt/auth/server';

const auth = createAuthServer();
const app = new Hono<{ Variables: { user: AuthUser } }>();

app.use('/api/*', async (c, next) => {
  const user = await auth.getUser(c.req.raw);
  if (!user) return c.json({ error: { code: 'unauthenticated', message: 'Sign in required.' } }, 401);
  c.set('user', user);
  await next();
});

app.get('/api/notes', async (c) => {
  const user = c.get('user');
  return c.json(await db.notes.findMany({ where: { ownerId: user.id } })); // ALWAYS scope by user.id
});
\`\`\`

High-stakes routes: \`await auth.requireUser(c.req.raw, { strict: true })\`.
`;

const NEXTJS = `# Basalt Auth — Next.js (App Router)

\`\`\`bash
npm install @basalt/auth
\`\`\`

### lib/auth-server.ts (server only)
\`\`\`ts
import 'server-only';
import { createAuthServer } from '@basalt/auth/server';
export const auth = createAuthServer(); // BASALT_PROJECT_ID, BASALT_AUTH_URL, BASALT_AUTH_SECRET_KEY — never NEXT_PUBLIC_
\`\`\`

### Server Components
\`\`\`tsx
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth-server';

export default async function Dashboard() {
  const user = await auth.getUser({ headers: await headers() });
  if (!user) redirect('/signin');
  const projects = await db.project.findMany({ where: { ownerId: user.id } });
  return <ProjectList projects={projects} />;
}
\`\`\`

### Route Handlers
\`\`\`ts
import { auth } from '@/lib/auth-server';

export async function POST(request: Request) {
  const user = await auth.getUser(request);
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  const { title } = await request.json();
  return Response.json(await db.todo.create({ data: { title, ownerId: user.id } }), { status: 201 });
}
\`\`\`

### Server Actions
\`\`\`ts
'use server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth-server';

export async function deleteTodo(id: string) {
  const user = await auth.requireUser({ headers: await headers(), method: 'POST' });
  await db.todo.deleteMany({ where: { id, ownerId: user.id } }); // scoping makes other users' ids harmless
}
\`\`\`

### Client side — app/providers.tsx
\`\`\`tsx
'use client';
import { AuthProvider } from '@basalt/auth/react';
export function Providers({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
\`\`\`
Wrap \`{children}\` in \`app/layout.tsx\` with \`<Providers>\`. Sign-up / sign-in / reset forms are identical to the **react** guide (use \`useAuth()\` inside 'use client' components).

### middleware.ts (optional redirect for signed-out users)
\`\`\`ts
import { NextResponse, type NextRequest } from 'next/server';
import { createAuthServer } from '@basalt/auth/server';
const auth = createAuthServer();

export async function middleware(req: NextRequest) {
  if (!(await auth.getUser(req))) return NextResponse.redirect(new URL('/signin', req.url));
}
export const config = { matcher: ['/dashboard/:path*'] };
\`\`\`
Middleware is a convenience: pages, route handlers and server actions must still check the user themselves.
`;

const NATIVE = `# Basalt Auth — native / mobile / CLI clients

Requests **without** an Origin header get tokens in the JSON body instead of cookies.
Base URL: \`\${BASALT_AUTH_URL}/v1/projects/\${BASALT_PROJECT_ID}\`

| Step | Request | Response |
|---|---|---|
| Sign up | \`POST /signup {email,password}\` | \`202 {status:'verification_required', signupToken}\` |
| Verify | \`POST /signup/verify {signupToken, code}\` | \`201 {user, accessToken, refreshToken, ...}\` |
| Sign in | \`POST /signin {email,password}\` | \`{status:'signed_in', accessToken, refreshToken}\` or \`{status:'mfa_required', mfaToken}\` |
| MFA | \`POST /signin/mfa {mfaToken, code}\` | tokens |
| Refresh | \`POST /session/refresh {refreshToken}\` | **new** accessToken + refreshToken |
| Sign out | \`POST /session/signout {refreshToken}\` | \`{status:'signed_out'}\` |
| Me | \`GET /session\` with \`Authorization: Bearer <accessToken>\` | \`{user}\` |

Rules:
- Store the refresh token only in the OS secure store (iOS Keychain / Android Keystore / expo-secure-store). Keep the access token in memory.
- **Always replace the stored refresh token with the new one from every refresh.** Reusing an old refresh token is treated as theft and signs the user out everywhere.
- Serialize refreshes (one at a time). A \`409 refresh_in_progress\` means another refresh just won — re-read the stored token and retry.
- Call your backend with \`Authorization: Bearer <accessToken>\`; on 401, refresh once and retry.
`;

const GUIDES: Record<Framework, string> = { react: REACT, nextjs: NEXTJS, express: EXPRESS, hono: HONO, native: NATIVE };

export function integrationGuide(framework: Framework): string {
  const pairing =
    framework === 'react'
      ? '\n> Pair this with a backend guide (express / hono / nextjs) so your API verifies the user.\n'
      : framework === 'express' || framework === 'hono'
        ? '\n> Pair this with the **react** guide for the frontend.\n'
        : '';
  return `${GUIDES[framework]}${pairing}\n${ENV}\n${RULES}`;
}
