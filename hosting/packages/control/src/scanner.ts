import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { reviewApiCode } from '@basalt/api-mcp';

export interface ScanFinding {
  file: string;
  line: number;
  rule: string;
  severity: string;
  problem: string;
  fix: string;
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private-key', /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ['aws-access-key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['stripe-live-key', /\b(sk|rk)_live_[0-9a-zA-Z]{20,}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['openai-key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{32,}\b/],
];
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|sql|vue|svelte)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.basalt-out', 'coverage', 'test-results', 'playwright-report']);

/**
 * Static checks every deployment passes before anything runs: the Basalt API/auth reviewers
 * (critical/high block the build) and hardcoded credential detection (always blocks).
 */
export async function scanSource(root: string): Promise<{ blocking: ScanFinding[]; warnings: ScanFinding[] }> {
  const blocking: ScanFinding[] = [];
  const warnings: ScanFinding[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if ((await stat(abs)).size > 1024 * 1024) continue;
      const text = await readFile(abs, 'utf8').catch(() => '');
      const lines = text.split('\n');
      for (const [rule, re] of SECRET_PATTERNS) {
        const i = lines.findIndex((l) => re.test(l));
        if (i >= 0) {
          blocking.push({ file: rel, line: i + 1, rule: `hardcoded-${rule}`, severity: 'critical', problem: 'A credential is hardcoded in source code.', fix: 'Remove it, rotate it at the provider, and store it with host_set_secret (read it from process.env).' });
        }
      }
      if (!CODE.test(entry.name) || /(^|\/)(e2e|tests?|__tests__)\//.test(rel) || /\.(test|spec)\.[jt]sx?$/.test(rel)) continue;
      for (const f of reviewApiCode(text, rel)) {
        const item = { file: rel, line: f.line, rule: f.rule, severity: f.severity, problem: f.problem, fix: f.fix };
        if (f.severity === 'critical' || f.severity === 'high') blocking.push(item);
        else warnings.push(item);
      }
    }
  }
  await walk(root);
  return { blocking, warnings };
}
