import { randomInt } from 'node:crypto';
import type { RequestMeta, ServiceContext } from '../context.js';
import type { Db } from '../db/db.js';
import { constantTimeEqual, randomNumericCode, randomToken, sha256, uuidv7 } from '../lib/crypto.js';
import { normalizeEmail } from '../lib/email.js';
import { AuthError } from '../lib/errors.js';
import type { EmailMessage } from '../lib/mailer.js';
import { assertAcceptablePassword } from '../lib/password.js';
import type { RateLimitRule } from '../lib/ratelimit.js';
import { base32Encode, generateTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';
import { audit } from './audit.js';
import {
  EMAIL_CODE_TTL_MINUTES,
  LIMITS,
  MAX_CODE_ATTEMPTS,
  MFA_CHALLENGE_TTL_SECONDS,
  PENDING_SIGNUP_TTL_MINUTES,
  RECOVERY_CODE_COUNT,
} from './limits.js';
import type { Project } from './projects.js';
import type { IssuedSession, SessionService } from './sessions.js';
import { type PublicUser, type UserRow, toPublicUser } from './users.js';

export type SignInResult =
  | { status: 'signed_in'; user: PublicUser; tokens: IssuedSession }
  | { status: 'mfa_required'; mfaToken: string; mfaTokenExpiresAt: Date };

export type SignUpResult =
  | { status: 'verification_required'; signupToken: string }
  | { status: 'signed_in'; user: PublicUser; tokens: IssuedSession };

/** Authenticated caller as established by the HTTP layer (verified JWT + live session). */
export interface Principal {
  project: Project;
  userId: string;
  sessionId: string;
}

const SIGNUP_TOKEN_PREFIX = 'bslt_su_';
const MFA_TOKEN_PREFIX = 'bslt_mfa_';
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const GENERIC_CODE_ERROR = 'That code is invalid or has expired.';

export class AccountService {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly sessions: SessionService,
  ) {}

  // ---------------------------------------------------------------- sign up

  async signUp(project: Project, input: { email?: unknown; password?: unknown }, meta: RequestMeta): Promise<SignUpResult> {
    const email = normalizeEmail(input.email);
    const password = typeof input.password === 'string' ? input.password : '';
    await this.limit(`su:ip:${project.id}:${meta.ipKey}`, LIMITS.signupPerIp);
    await this.limit(`su:em:${project.id}:${email.normalized}`, LIMITS.signupPerEmail);
    await assertAcceptablePassword(
      password,
      { minLength: project.settings.passwordMinLength, checkBreached: project.settings.checkBreachedPasswords },
      { email: email.normalized, breachChecker: this.ctx.breachChecker },
    );
    // Hash before looking the email up so "new" and "existing" paths cost the same.
    const passwordHash = await this.ctx.hasher.hash(password);
    const existing = await this.findUserByEmail(project.id, email.normalized);

    if (!project.settings.requireEmailVerification) {
      if (existing) throw new AuthError('email_taken', 'An account with this email already exists.');
      return this.ctx.db.transaction(async (tx) => {
        const user = await this.insertUser(tx, project.id, email, passwordHash, null);
        if (!user) throw new AuthError('email_taken', 'An account with this email already exists.');
        await audit(tx, { projectId: project.id, userId: user.id, type: 'user.signed_up', meta });
        const tokens = await this.sessions.create(tx, project, user, ['pwd'], meta);
        return { status: 'signed_in' as const, user: toPublicUser(user), tokens };
      });
    }

    const signupToken = randomToken(SIGNUP_TOKEN_PREFIX);
    if (existing) {
      // Same response as a fresh sign-up so the endpoint can't be used to enumerate accounts.
      // The real owner gets a heads-up email instead of a code.
      this.sendMail(project, { template: 'account_exists', to: existing.email, appName: appName(project) });
      return { status: 'verification_required', signupToken };
    }

    const id = uuidv7();
    const code = randomNumericCode(6);
    const now = this.ctx.now();
    await this.ctx.db.query(
      `INSERT INTO auth_pending_signups
         (id, project_id, email, email_normalized, password_hash, signup_token_hash, code_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        project.id,
        email.display,
        email.normalized,
        passwordHash,
        sha256(signupToken),
        this.ctx.keyRing.hashCode(`signup:${id}`, code),
        addMinutes(now, PENDING_SIGNUP_TTL_MINUTES),
        now,
      ],
    );
    this.sendMail(project, {
      template: 'verify_email',
      to: email.display,
      appName: appName(project),
      code,
      expiresInMinutes: PENDING_SIGNUP_TTL_MINUTES,
    });
    return { status: 'verification_required', signupToken };
  }

  async verifySignup(project: Project, input: { signupToken?: unknown; code?: unknown }, meta: RequestMeta) {
    await this.limit(`vs:ip:${project.id}:${meta.ipKey}`, LIMITS.verifyPerIp);
    const token = typeof input.signupToken === 'string' ? input.signupToken : '';
    const code = normalizeNumericCode(input.code);
    if (!token.startsWith(SIGNUP_TOKEN_PREFIX) || !code) throw new AuthError('invalid_code', GENERIC_CODE_ERROR);

    const result = await this.ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<PendingSignupRow>(
        'SELECT * FROM auth_pending_signups WHERE signup_token_hash = $1 AND project_id = $2 FOR UPDATE',
        [sha256(token), project.id],
      );
      const pending = rows[0];
      if (!pending || pending.expires_at <= this.ctx.now()) return { error: 'invalid_code' as const };
      if (!constantTimeEqual(this.ctx.keyRing.hashCode(`signup:${pending.id}`, code), pending.code_hash)) {
        const attempts = pending.attempts + 1;
        if (attempts >= MAX_CODE_ATTEMPTS) {
          await tx.query('DELETE FROM auth_pending_signups WHERE id = $1', [pending.id]);
          return { error: 'too_many_attempts' as const };
        }
        await tx.query('UPDATE auth_pending_signups SET attempts = $2 WHERE id = $1', [pending.id, attempts]);
        return { error: 'invalid_code' as const };
      }

      // Email proven. Every other pending sign-up for this address is now moot.
      await tx.query('DELETE FROM auth_pending_signups WHERE project_id = $1 AND email_normalized = $2', [
        project.id,
        pending.email_normalized,
      ]);
      const inserted = await this.insertUser(
        tx,
        project.id,
        { display: pending.email, normalized: pending.email_normalized },
        pending.password_hash,
        this.ctx.now(),
      );
      if (!inserted) return { error: 'email_taken' as const };
      await audit(tx, { projectId: project.id, userId: inserted.id, type: 'user.signed_up', meta });
      await audit(tx, { projectId: project.id, userId: inserted.id, type: 'user.email_verified', meta });
      const tokens = await this.sessions.create(tx, project, inserted, ['pwd'], meta);
      return { user: toPublicUser(inserted), tokens };
    });

    if ('error' in result) {
      if (result.error === 'too_many_attempts') {
        throw new AuthError('too_many_attempts', 'Too many incorrect codes. Please sign up again.');
      }
      if (result.error === 'email_taken') {
        throw new AuthError('email_taken', 'An account with this email already exists. Please sign in.');
      }
      throw new AuthError('invalid_code', GENERIC_CODE_ERROR);
    }
    return { status: 'signed_in' as const, ...result };
  }

  async resendSignupCode(project: Project, input: { signupToken?: unknown }, meta: RequestMeta) {
    await this.limit(`vs:ip:${project.id}:${meta.ipKey}`, LIMITS.verifyPerIp);
    const token = typeof input.signupToken === 'string' ? input.signupToken : '';
    if (!token.startsWith(SIGNUP_TOKEN_PREFIX)) return;
    await this.limit(`rs:${sha256(token).toString('hex')}`, LIMITS.resendPerSignup);
    const { rows } = await this.ctx.db.query<PendingSignupRow>(
      'SELECT * FROM auth_pending_signups WHERE signup_token_hash = $1 AND project_id = $2',
      [sha256(token), project.id],
    );
    const pending = rows[0];
    // Unknown tokens (incl. the decoy issued for existing accounts) succeed silently.
    if (!pending || pending.expires_at <= this.ctx.now()) return;
    const code = randomNumericCode(6);
    await this.ctx.db.query(
      'UPDATE auth_pending_signups SET code_hash = $2, attempts = 0, expires_at = $3 WHERE id = $1',
      [pending.id, this.ctx.keyRing.hashCode(`signup:${pending.id}`, code), addMinutes(this.ctx.now(), PENDING_SIGNUP_TTL_MINUTES)],
    );
    this.sendMail(project, {
      template: 'verify_email',
      to: pending.email,
      appName: appName(project),
      code,
      expiresInMinutes: PENDING_SIGNUP_TTL_MINUTES,
    });
  }

  // ---------------------------------------------------------------- sign in

  async signIn(project: Project, input: { email?: unknown; password?: unknown }, meta: RequestMeta): Promise<SignInResult> {
    const email = normalizeEmail(input.email);
    const password = typeof input.password === 'string' ? input.password : '';
    if (!password || password.length > 1024) throw new AuthError('invalid_credentials', 'Incorrect email or password.');
    await this.limit(`si:ip:${project.id}:${meta.ipKey}`, LIMITS.signinPerIp);
    const accountIpKey = `si:acct-ip:${project.id}:${email.normalized}:${meta.ipKey}`;
    await this.limit(accountIpKey, LIMITS.signinPerAccountIp);
    await this.limit(`si:acct:${project.id}:${email.normalized}`, LIMITS.signinPerAccount);

    const user = await this.findUserByEmail(project.id, email.normalized);
    if (!user || !user.password_hash) {
      await this.ctx.hasher.verifyDummy(password);
      await audit(this.ctx.db, { projectId: project.id, type: 'user.sign_in_failed', meta, data: { reason: 'unknown_email' } });
      throw new AuthError('invalid_credentials', 'Incorrect email or password.');
    }
    if (!(await this.ctx.hasher.verify(password, user.password_hash))) {
      await audit(this.ctx.db, { projectId: project.id, userId: user.id, type: 'user.sign_in_failed', meta, data: { reason: 'bad_password' } });
      throw new AuthError('invalid_credentials', 'Incorrect email or password.');
    }
    // Below here the caller has proven knowledge of the password, so specific errors are safe.
    await this.ctx.rateLimiter.reset(accountIpKey);
    if (user.disabled_at) throw new AuthError('account_disabled', 'This account has been disabled.');
    if (this.ctx.hasher.needsRehash(user.password_hash)) {
      const rehashed = await this.ctx.hasher.hash(password);
      await this.ctx.db.query('UPDATE auth_users SET password_hash = $2 WHERE id = $1', [user.id, rehashed]);
    }
    if (project.settings.requireEmailVerification && !user.email_verified_at) {
      await this.issueEmailCode(project, user, 'verify_email');
      throw new AuthError('email_not_verified', 'Verify your email to continue. We sent you a code.');
    }

    if (user.totp_enabled_at) {
      const mfaToken = randomToken(MFA_TOKEN_PREFIX);
      const expiresAt = new Date(this.ctx.now().getTime() + MFA_CHALLENGE_TTL_SECONDS * 1000);
      await this.ctx.db.query(
        `INSERT INTO auth_mfa_challenges (token_hash, project_id, user_id, expires_at) VALUES ($1, $2, $3, $4)`,
        [sha256(mfaToken), project.id, user.id, expiresAt],
      );
      return { status: 'mfa_required', mfaToken, mfaTokenExpiresAt: expiresAt };
    }

    return this.ctx.db.transaction(async (tx) => {
      const tokens = await this.sessions.create(tx, project, user, ['pwd'], meta);
      await audit(tx, { projectId: project.id, userId: user.id, type: 'user.signed_in', meta, data: { amr: ['pwd'] } });
      return { status: 'signed_in' as const, user: toPublicUser(user), tokens };
    });
  }

  async completeMfa(project: Project, input: { mfaToken?: unknown; code?: unknown }, meta: RequestMeta) {
    const token = typeof input.mfaToken === 'string' ? input.mfaToken : '';
    const rawCode = typeof input.code === 'string' ? input.code.trim() : '';
    if (!token.startsWith(MFA_TOKEN_PREFIX) || !rawCode) throw new AuthError('invalid_code', GENERIC_CODE_ERROR);

    const { rows } = await this.ctx.db.query<{ user_id: string }>(
      'SELECT user_id FROM auth_mfa_challenges WHERE token_hash = $1 AND project_id = $2',
      [sha256(token), project.id],
    );
    if (rows[0]) await this.limit(`mfa:user:${rows[0].user_id}`, LIMITS.mfaPerUser);

    const result = await this.ctx.db.transaction(async (tx) => {
      const ch = (
        await tx.query<{ user_id: string; attempts: number; expires_at: Date; consumed_at: Date | null }>(
          'SELECT * FROM auth_mfa_challenges WHERE token_hash = $1 AND project_id = $2 FOR UPDATE',
          [sha256(token), project.id],
        )
      ).rows[0];
      if (!ch || ch.consumed_at || ch.expires_at <= this.ctx.now()) return { error: 'expired' as const };
      const user = (
        await tx.query<UserRow>('SELECT * FROM auth_users WHERE id = $1 AND project_id = $2 FOR UPDATE', [ch.user_id, project.id])
      ).rows[0];
      if (!user || user.disabled_at || !user.totp_enabled_at) return { error: 'expired' as const };

      const method = await this.checkSecondFactor(tx, user, rawCode);
      if (!method) {
        const attempts = ch.attempts + 1;
        await tx.query(
          'UPDATE auth_mfa_challenges SET attempts = $2::int, consumed_at = CASE WHEN $2::int >= $3::int THEN now() ELSE NULL END WHERE token_hash = $1',
          [sha256(token), attempts, MAX_CODE_ATTEMPTS],
        );
        await audit(tx, { projectId: project.id, userId: user.id, type: 'user.mfa_failed', meta });
        return { error: attempts >= MAX_CODE_ATTEMPTS ? ('too_many_attempts' as const) : ('invalid_code' as const) };
      }
      await tx.query('UPDATE auth_mfa_challenges SET consumed_at = now() WHERE token_hash = $1', [sha256(token)]);
      const amr = ['pwd', method === 'totp' ? 'otp' : 'recovery'];
      const tokens = await this.sessions.create(tx, project, user, amr, meta);
      await audit(tx, { projectId: project.id, userId: user.id, type: 'user.signed_in', meta, data: { amr } });
      return { user: toPublicUser(user), tokens };
    });

    if ('error' in result) {
      if (result.error === 'expired') throw new AuthError('invalid_token', 'Sign-in expired. Please sign in again.');
      if (result.error === 'too_many_attempts') {
        throw new AuthError('too_many_attempts', 'Too many incorrect codes. Please sign in again.');
      }
      throw new AuthError('invalid_code', GENERIC_CODE_ERROR);
    }
    return { status: 'signed_in' as const, ...result };
  }

  // ---------------------------------------------------------------- email codes (reset / verify)

  /** Always resolves the same way whether or not the account exists. Work happens in the background. */
  async requestPasswordReset(project: Project, input: { email?: unknown }, meta: RequestMeta) {
    const email = normalizeEmail(input.email);
    await this.limit(`rr:ip:${project.id}:${meta.ipKey}`, LIMITS.resetRequestPerIp);
    await this.limit(`rr:em:${project.id}:${email.normalized}`, LIMITS.resetRequestPerEmail);
    this.background(async () => {
      const user = await this.findUserByEmail(project.id, email.normalized);
      if (user && !user.disabled_at) await this.issueEmailCode(project, user, 'reset_password');
    });
  }

  async resetPassword(project: Project, input: { email?: unknown; code?: unknown; newPassword?: unknown }, meta: RequestMeta) {
    const email = normalizeEmail(input.email);
    await this.limit(`rc:ip:${project.id}:${meta.ipKey}`, LIMITS.resetConfirmPerIp);
    const code = normalizeNumericCode(input.code);
    const password = typeof input.newPassword === 'string' ? input.newPassword : '';
    if (!code) throw new AuthError('invalid_code', GENERIC_CODE_ERROR);
    // Validate the new password first so a typo doesn't burn the code.
    await assertAcceptablePassword(
      password,
      { minLength: project.settings.passwordMinLength, checkBreached: project.settings.checkBreachedPasswords },
      { email: email.normalized, breachChecker: this.ctx.breachChecker },
    );
    const user = await this.findUserByEmail(project.id, email.normalized);
    if (!user || user.disabled_at) {
      await this.ctx.hasher.verifyDummy(password); // same cost as the real path: no timing oracle
      throw new AuthError('invalid_code', GENERIC_CODE_ERROR);
    }
    const passwordHash = await this.ctx.hasher.hash(password);

    const outcome = await this.ctx.db.transaction(async (tx) => {
      const check = await this.consumeEmailCode(tx, user, 'reset_password', code);
      if (check !== 'ok') return check;
      await tx.query(
        `UPDATE auth_users SET password_hash = $2, password_changed_at = $3, updated_at = $3,
           email_verified_at = COALESCE(email_verified_at, $3) WHERE id = $1`,
        [user.id, passwordHash, this.ctx.now()],
      );
      await tx.query(
        `UPDATE auth_email_codes SET consumed_at = $2 WHERE user_id = $1 AND purpose = 'reset_password' AND consumed_at IS NULL`,
        [user.id, this.ctx.now()],
      );
      await this.sessions.revokeAllForUser(tx, project.id, user.id, 'password_reset');
      await audit(tx, { projectId: project.id, userId: user.id, type: 'user.password_reset', meta });
      return check;
    });
    if (outcome !== 'ok') throw codeError(outcome);
    this.sendMail(project, { template: 'password_changed', to: user.email, appName: appName(project) });
    // No automatic sign-in: the user signs in with the new password (and MFA, if enabled).
  }

  /** Verifies an existing account's email with a code (sent at sign-in or via sendEmailVerification) and signs in. */
  async verifyEmail(project: Project, input: { email?: unknown; code?: unknown }, meta: RequestMeta) {
    const email = normalizeEmail(input.email);
    await this.limit(`vs:ip:${project.id}:${meta.ipKey}`, LIMITS.verifyPerIp);
    const code = normalizeNumericCode(input.code);
    if (!code) throw new AuthError('invalid_code', GENERIC_CODE_ERROR);
    const user = await this.findUserByEmail(project.id, email.normalized);
    if (!user || user.disabled_at) throw new AuthError('invalid_code', GENERIC_CODE_ERROR);

    const result = await this.ctx.db.transaction(async (tx) => {
      const check = await this.consumeEmailCode(tx, user, 'verify_email', code);
      if (check !== 'ok') return { error: check };
      const now = this.ctx.now();
      const updated = (
        await tx.query<UserRow>(
          'UPDATE auth_users SET email_verified_at = COALESCE(email_verified_at, $2), updated_at = $2 WHERE id = $1 RETURNING *',
          [user.id, now],
        )
      ).rows[0]!;
      await audit(tx, { projectId: project.id, userId: user.id, type: 'user.email_verified', meta });
      if (updated.totp_enabled_at) {
        // Email possession alone must never bypass MFA.
        return { status: 'email_verified' as const, user: toPublicUser(updated) };
      }
      const tokens = await this.sessions.create(tx, project, updated, ['email'], meta);
      return { status: 'signed_in' as const, user: toPublicUser(updated), tokens };
    });
    if ('error' in result && result.error) throw codeError(result.error);
    return result as Exclude<typeof result, { error: unknown }>;
  }

  async sendEmailVerification(principal: Principal) {
    const user = await this.requireUser(principal);
    if (user.email_verified_at) return;
    await this.limit(`ev:${user.id}`, LIMITS.emailCodePerUser);
    await this.issueEmailCode(principal.project, user, 'verify_email');
  }

  // ---------------------------------------------------------------- signed-in account management

  async getUser(principal: Principal): Promise<PublicUser> {
    return toPublicUser(await this.requireUser(principal));
  }

  async changePassword(principal: Principal, input: { currentPassword?: unknown; newPassword?: unknown }, meta: RequestMeta) {
    const { project } = principal;
    const user = await this.requireUser(principal);
    await this.limit(`sens:${user.id}`, LIMITS.sensitivePerUser);
    await this.assertPassword(user, input.currentPassword);
    const password = typeof input.newPassword === 'string' ? input.newPassword : '';
    await assertAcceptablePassword(
      password,
      { minLength: project.settings.passwordMinLength, checkBreached: project.settings.checkBreachedPasswords },
      { email: user.email_normalized, breachChecker: this.ctx.breachChecker },
    );
    const hash = await this.ctx.hasher.hash(password);
    await this.ctx.db.transaction(async (tx) => {
      await tx.query('UPDATE auth_users SET password_hash = $2, password_changed_at = $3, updated_at = $3 WHERE id = $1', [
        user.id,
        hash,
        this.ctx.now(),
      ]);
      await this.sessions.revokeAllForUser(tx, project.id, user.id, 'password_changed', principal.sessionId);
      await audit(tx, { projectId: project.id, userId: user.id, type: 'user.password_changed', meta });
    });
    this.sendMail(project, { template: 'password_changed', to: user.email, appName: appName(project) });
  }

  /**
   * Step-up authentication: the signed-in user proves who they are again (password, plus a second
   * factor if enrolled). Backends can then require a recent `auth_time` for sensitive actions.
   */
  async reauthenticate(principal: Principal, input: { password?: unknown; code?: unknown }, meta: RequestMeta) {
    const { project } = principal;
    const user = await this.requireUser(principal);
    await this.limit(`sens:${user.id}`, LIMITS.sensitivePerUser);
    await this.assertPassword(user, input.password);
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (user.totp_enabled_at && !code) {
      throw new AuthError('mfa_required', 'Enter the code from your authenticator app.');
    }
    const access = await this.ctx.db.transaction(async (tx) => {
      let amr = ['pwd'];
      if (user.totp_enabled_at) {
        const locked = (await tx.query<UserRow>('SELECT * FROM auth_users WHERE id = $1 FOR UPDATE', [user.id])).rows[0]!;
        const method = await this.checkSecondFactor(tx, locked, code);
        if (!method) throw new AuthError('invalid_code', 'That code is incorrect.');
        amr = ['pwd', method === 'totp' ? 'otp' : 'recovery'];
      }
      const issued = await this.sessions.markAuthenticated(tx, project, user, principal.sessionId, amr);
      await audit(tx, { projectId: project.id, userId: user.id, type: 'session.reauthenticated', meta, data: { amr } });
      return issued;
    });
    return { user: toPublicUser(user), sessionId: principal.sessionId, access };
  }

  async beginTotpEnrollment(principal: Principal) {
    const { project } = principal;
    if (!project.settings.allowTotp) throw new AuthError('forbidden', 'Authenticator apps are not enabled for this app.');
    const user = await this.requireUser(principal);
    if (user.totp_enabled_at) throw new AuthError('conflict', 'Two-factor authentication is already enabled.');
    const secret = generateTotpSecret();
    await this.ctx.db.query('UPDATE auth_users SET totp_secret_enc = $2, totp_last_step = NULL WHERE id = $1', [
      user.id,
      this.ctx.keyRing.encrypt(secret, `totp:${user.id}`),
    ]);
    return { secret: base32Encode(secret), otpauthUrl: otpauthUrl(secret, appName(project), user.email) };
  }

  async confirmTotpEnrollment(principal: Principal, input: { code?: unknown }, meta: RequestMeta) {
    const { project } = principal;
    const user = await this.requireUser(principal);
    await this.limit(`sens:${user.id}`, LIMITS.sensitivePerUser);
    if (user.totp_enabled_at) throw new AuthError('conflict', 'Two-factor authentication is already enabled.');
    if (!user.totp_secret_enc) throw new AuthError('invalid_request', 'Start enrollment first.');
    const secret = this.ctx.keyRing.decrypt(user.totp_secret_enc, `totp:${user.id}`);
    const step = verifyTotp(secret, typeof input.code === 'string' ? input.code.trim() : '', null, this.ctx.now().getTime());
    if (step === null) throw new AuthError('invalid_code', 'That code is incorrect. Check your authenticator app.');

    const recoveryCodes = generateRecoveryCodes();
    await this.ctx.db.transaction(async (tx) => {
      await tx.query('UPDATE auth_users SET totp_enabled_at = $2, totp_last_step = $3, updated_at = $2 WHERE id = $1', [
        user.id,
        this.ctx.now(),
        step,
      ]);
      await this.replaceRecoveryCodes(tx, user.id, recoveryCodes);
      await audit(tx, { projectId: project.id, userId: user.id, type: 'user.mfa_enabled', meta });
    });
    this.sendMail(project, { template: 'mfa_enabled', to: user.email, appName: appName(project) });
    return { recoveryCodes };
  }

  async disableTotp(principal: Principal, input: { password?: unknown; code?: unknown }, meta: RequestMeta) {
    const { project } = principal;
    const user = await this.requireUser(principal);
    await this.limit(`sens:${user.id}`, LIMITS.sensitivePerUser);
    if (!user.totp_enabled_at) return;
    await this.assertPassword(user, input.password);
    await this.ctx.db.transaction(async (tx) => {
      const locked = (await tx.query<UserRow>('SELECT * FROM auth_users WHERE id = $1 FOR UPDATE', [user.id])).rows[0]!;
      if (!(await this.checkSecondFactor(tx, locked, typeof input.code === 'string' ? input.code.trim() : ''))) {
        throw new AuthError('invalid_code', 'That code is incorrect.');
      }
      await tx.query(
        'UPDATE auth_users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = $2 WHERE id = $1',
        [user.id, this.ctx.now()],
      );
      await tx.query('DELETE FROM auth_recovery_codes WHERE user_id = $1', [user.id]);
      await audit(tx, { projectId: project.id, userId: user.id, type: 'user.mfa_disabled', meta });
    });
    this.sendMail(project, { template: 'mfa_disabled', to: user.email, appName: appName(project) });
  }

  async regenerateRecoveryCodes(principal: Principal, input: { code?: unknown }) {
    const user = await this.requireUser(principal);
    await this.limit(`sens:${user.id}`, LIMITS.sensitivePerUser);
    if (!user.totp_enabled_at) throw new AuthError('invalid_request', 'Two-factor authentication is not enabled.');
    const recoveryCodes = generateRecoveryCodes();
    await this.ctx.db.transaction(async (tx) => {
      const locked = (await tx.query<UserRow>('SELECT * FROM auth_users WHERE id = $1 FOR UPDATE', [user.id])).rows[0]!;
      const code = typeof input.code === 'string' ? input.code.trim() : '';
      if ((await this.checkSecondFactor(tx, locked, code, { totpOnly: true })) !== 'totp') {
        throw new AuthError('invalid_code', 'That code is incorrect.');
      }
      await this.replaceRecoveryCodes(tx, user.id, recoveryCodes);
    });
    return { recoveryCodes };
  }

  async deleteAccount(principal: Principal, input: { password?: unknown }, meta: RequestMeta) {
    const user = await this.requireUser(principal);
    await this.limit(`sens:${user.id}`, LIMITS.sensitivePerUser);
    await this.assertPassword(user, input.password);
    await this.ctx.db.transaction(async (tx) => {
      await audit(tx, { projectId: principal.project.id, userId: user.id, type: 'user.deleted', meta, data: { by: 'self' } });
      await tx.query('DELETE FROM auth_users WHERE id = $1', [user.id]);
    });
  }

  // ---------------------------------------------------------------- internals

  /** Awaits any fire-and-forget work (emails). Used by tests and graceful shutdown. */
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private background(fn: () => Promise<void>) {
    const p = fn()
      .catch((err) => this.ctx.log.error('background_task_failed', { err }))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private sendMail(project: Project, message: EmailMessage) {
    this.background(() => this.ctx.mailer.send({ ...message, projectId: project.id }));
  }

  private async limit(key: string, rule: RateLimitRule) {
    const r = await this.ctx.rateLimiter.hit(key, rule);
    if (!r.allowed) {
      throw new AuthError('rate_limited', 'Too many attempts. Please wait and try again.', {
        retryAfterSeconds: r.retryAfterSeconds,
      });
    }
  }

  private async requireUser(principal: Principal): Promise<UserRow> {
    const { rows } = await this.ctx.db.query<UserRow>('SELECT * FROM auth_users WHERE id = $1 AND project_id = $2', [
      principal.userId,
      principal.project.id,
    ]);
    const user = rows[0];
    if (!user || user.disabled_at) throw new AuthError('unauthenticated', 'Please sign in again.');
    return user;
  }

  private async assertPassword(user: UserRow, presented: unknown) {
    const ok =
      typeof presented === 'string' &&
      presented.length <= 1024 &&
      user.password_hash !== null &&
      (await this.ctx.hasher.verify(presented, user.password_hash));
    if (!ok) throw new AuthError('invalid_credentials', 'Incorrect password.');
  }

  private async findUserByEmail(projectId: string, normalized: string): Promise<UserRow | null> {
    const { rows } = await this.ctx.db.query<UserRow>(
      'SELECT * FROM auth_users WHERE project_id = $1 AND email_normalized = $2',
      [projectId, normalized],
    );
    return rows[0] ?? null;
  }

  private async insertUser(
    tx: Db,
    projectId: string,
    email: { display: string; normalized: string },
    passwordHash: string,
    verifiedAt: Date | null,
  ): Promise<UserRow | null> {
    const now = this.ctx.now();
    const { rows } = await tx.query<UserRow>(
      `INSERT INTO auth_users (id, project_id, email, email_normalized, email_verified_at, password_hash, password_changed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)
       ON CONFLICT (project_id, email_normalized) DO NOTHING RETURNING *`,
      [uuidv7(), projectId, email.display, email.normalized, verifiedAt, passwordHash, now],
    );
    return rows[0] ?? null;
  }

  private async issueEmailCode(project: Project, user: UserRow, purpose: 'reset_password' | 'verify_email') {
    const id = uuidv7();
    const code = randomNumericCode(6);
    const now = this.ctx.now();
    await this.ctx.db.transaction(async (tx) => {
      // Only the newest code is valid; issuing a new one invalidates older ones.
      await tx.query(
        'UPDATE auth_email_codes SET consumed_at = $3 WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL',
        [user.id, purpose, now],
      );
      await tx.query(
        `INSERT INTO auth_email_codes (id, project_id, user_id, purpose, code_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, project.id, user.id, purpose, this.ctx.keyRing.hashCode(`email:${id}`, code), addMinutes(now, EMAIL_CODE_TTL_MINUTES), now],
      );
    });
    this.sendMail(project, {
      template: purpose === 'reset_password' ? 'reset_password' : 'verify_email',
      to: user.email,
      appName: appName(project),
      code,
      expiresInMinutes: EMAIL_CODE_TTL_MINUTES,
    });
  }

  /**
   * Checks the newest live code for `purpose`. Wrong guesses are counted on the row (and the code
   * is burned after MAX_CODE_ATTEMPTS). Never throws, so the caller's transaction commits the
   * attempt counter; the caller throws via `codeError` afterwards.
   */
  private async consumeEmailCode(
    tx: Db,
    user: UserRow,
    purpose: 'reset_password' | 'verify_email',
    code: string,
  ): Promise<CodeOutcome> {
    const { rows } = await tx.query<{ id: string; code_hash: Buffer; attempts: number; expires_at: Date }>(
      `SELECT id, code_hash, attempts, expires_at FROM auth_email_codes
       WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [user.id, purpose],
    );
    const row = rows[0];
    if (!row || row.expires_at <= this.ctx.now()) return 'invalid_code';
    if (!constantTimeEqual(this.ctx.keyRing.hashCode(`email:${row.id}`, code), row.code_hash)) {
      const attempts = row.attempts + 1;
      await tx.query(
        `UPDATE auth_email_codes SET attempts = $2::int, consumed_at = CASE WHEN $2::int >= $3::int THEN $4::timestamptz ELSE NULL END WHERE id = $1`,
        [row.id, attempts, MAX_CODE_ATTEMPTS, this.ctx.now()],
      );
      return attempts >= MAX_CODE_ATTEMPTS ? 'too_many_attempts' : 'invalid_code';
    }
    await tx.query('UPDATE auth_email_codes SET consumed_at = $2 WHERE id = $1', [row.id, this.ctx.now()]);
    return 'ok';
  }

  /** Checks a TOTP or recovery code against a row locked FOR UPDATE by the caller. */
  private async checkSecondFactor(
    tx: Db,
    user: UserRow,
    code: string,
    opts: { totpOnly?: boolean } = {},
  ): Promise<'totp' | 'recovery' | null> {
    if (!user.totp_secret_enc || !user.totp_enabled_at) return null;
    const digits = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(digits)) {
      const secret = this.ctx.keyRing.decrypt(user.totp_secret_enc, `totp:${user.id}`);
      const last = user.totp_last_step === null ? null : Number(user.totp_last_step);
      const step = verifyTotp(secret, digits, last, this.ctx.now().getTime());
      if (step === null) return null;
      await tx.query('UPDATE auth_users SET totp_last_step = $2 WHERE id = $1', [user.id, step]);
      return 'totp';
    }
    if (opts.totpOnly) return null;
    const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized.length !== 10) return null;
    const { rowCount } = await tx.query(
      'UPDATE auth_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL',
      [user.id, this.ctx.keyRing.hashCode(`recovery:${user.id}`, normalized)],
    );
    if (rowCount === 0) return null;
    await audit(tx, { projectId: user.project_id, userId: user.id, type: 'user.recovery_code_used' });
    return 'recovery';
  }

  private async replaceRecoveryCodes(tx: Db, userId: string, codes: string[]) {
    await tx.query('DELETE FROM auth_recovery_codes WHERE user_id = $1', [userId]);
    for (const c of codes) {
      await tx.query('INSERT INTO auth_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [
        userId,
        this.ctx.keyRing.hashCode(`recovery:${userId}`, c.replace('-', '')),
      ]);
    }
  }
}

interface PendingSignupRow {
  id: string;
  project_id: string;
  email: string;
  email_normalized: string;
  password_hash: string;
  code_hash: Buffer;
  attempts: number;
  expires_at: Date;
}

function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    let s = '';
    for (let i = 0; i < 10; i++) s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

type CodeOutcome = 'ok' | 'invalid_code' | 'too_many_attempts';

function codeError(outcome: Exclude<CodeOutcome, 'ok'>) {
  return outcome === 'too_many_attempts'
    ? new AuthError('too_many_attempts', 'Too many incorrect codes. Request a new one.')
    : new AuthError('invalid_code', GENERIC_CODE_ERROR);
}

function normalizeNumericCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

function addMinutes(d: Date, minutes: number) {
  return new Date(d.getTime() + minutes * 60_000);
}

function appName(project: Project) {
  return project.settings.appName ?? project.name;
}

