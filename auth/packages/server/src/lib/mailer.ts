import { createHmac } from 'node:crypto';
import type { Logger } from './logger.js';

export type EmailMessage =
  | { template: 'verify_email'; to: string; appName: string; code: string; expiresInMinutes: number }
  | { template: 'account_exists'; to: string; appName: string }
  | { template: 'reset_password'; to: string; appName: string; code: string; expiresInMinutes: number }
  | { template: 'password_changed'; to: string; appName: string }
  | { template: 'mfa_enabled'; to: string; appName: string }
  | { template: 'mfa_disabled'; to: string; appName: string };

export interface Mailer {
  send(message: EmailMessage & { projectId: string }): Promise<void>;
}

export function renderEmail(m: EmailMessage): { subject: string; text: string } {
  switch (m.template) {
    case 'verify_email':
      return {
        subject: `${m.code} is your ${m.appName} verification code`,
        text: `Your ${m.appName} verification code is ${m.code}.\n\nIt expires in ${m.expiresInMinutes} minutes. If you didn't try to sign up, you can ignore this email.`,
      };
    case 'account_exists':
      return {
        subject: `Sign-up attempt for your ${m.appName} account`,
        text: `Someone tried to create a ${m.appName} account with this email, but you already have one.\n\nIf this was you, sign in instead — or reset your password if you've forgotten it. If it wasn't you, no action is needed.`,
      };
    case 'reset_password':
      return {
        subject: `${m.code} is your ${m.appName} password reset code`,
        text: `Your ${m.appName} password reset code is ${m.code}.\n\nIt expires in ${m.expiresInMinutes} minutes. If you didn't request this, ignore this email — your password won't change.`,
      };
    case 'password_changed':
      return {
        subject: `Your ${m.appName} password was changed`,
        text: `The password for your ${m.appName} account was just changed and all other sessions were signed out.\n\nIf you didn't do this, reset your password immediately.`,
      };
    case 'mfa_enabled':
      return {
        subject: `Two-factor authentication enabled on ${m.appName}`,
        text: `Two-factor authentication was turned on for your ${m.appName} account. If you didn't do this, reset your password immediately.`,
      };
    case 'mfa_disabled':
      return {
        subject: `Two-factor authentication disabled on ${m.appName}`,
        text: `Two-factor authentication was turned off for your ${m.appName} account. If you didn't do this, reset your password immediately and re-enable it.`,
      };
  }
}

/** Development only: prints emails to the log so codes can be copied. Refused in production by config. */
export class ConsoleMailer implements Mailer {
  readonly outbox: Array<EmailMessage & { projectId: string }> = [];
  constructor(private readonly log?: Logger) {}
  async send(message: EmailMessage & { projectId: string }) {
    this.outbox.push(message);
    if (this.outbox.length > 1000) this.outbox.shift();
    const { subject, text } = renderEmail(message);
    this.log?.info('email.console', { to: message.to, subject, text });
  }
}

/**
 * Hands rendered mail to the platform's email service. Requests are signed with
 * HMAC-SHA256(secret, timestamp + "." + body) in the `Basalt-Signature` header.
 */
export class WebhookMailer implements Mailer {
  constructor(
    private readonly url: string,
    private readonly secret: string,
  ) {}

  async send(message: EmailMessage & { projectId: string }) {
    const { subject, text } = renderEmail(message);
    const body = JSON.stringify({
      projectId: message.projectId,
      template: message.template,
      to: message.to,
      subject,
      text,
    });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac('sha256', this.secret).update(`${ts}.${body}`).digest('hex');
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'basalt-signature': `t=${ts},v1=${sig}` },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Mail webhook responded ${res.status}`);
  }
}
