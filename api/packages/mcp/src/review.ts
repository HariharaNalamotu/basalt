import { reviewCode as reviewAuthCode, type Finding, type Severity } from '@basalt/auth-mcp';

interface Rule {
  id: string;
  severity: Severity;
  pattern: RegExp;
  problem: string;
  fix: string;
  /** Skip for files that are allowed to do this (e.g. migration tooling). */
  skipPath?: RegExp;
}

const RULES: Rule[] = [
  {
    id: 'sql-string-building',
    severity: 'critical',
    pattern: /\.query\(\s*`[^`]*\$\{|\.query\(\s*['"][^'"]*['"]\s*\+|\bsql(\.one|\.maybeOne|\.exec)?\(\s*['"`]|\bsql\.unsafe|\bsql\(\s*`/,
    problem: 'SQL is built from strings: SQL injection.',
    fix: 'Use the tagged template: ctx.sql`SELECT ... WHERE id = ${id}` (values become bind parameters). For optional clauses nest imported sql`` fragments.',
  },
  {
    id: 'raw-database-client',
    severity: 'high',
    pattern: /from\s+['"](pg|postgres|mysql2?|knex|kysely)['"]|require\(\s*['"]pg['"]\s*\)|new\s+(pg\.)?(Pool|Client)\s*\(/,
    skipPath: /(^|\/)(db\/|scripts\/|migrations?\/)/,
    problem: 'A raw database client bypasses the per-request transaction that carries the user\'s data grant.',
    fix: 'Query through ctx.sql in route handlers. Migrations run with basalt-migrate.',
  },
  {
    id: 'competing-http-server',
    severity: 'high',
    pattern: /from\s+['"](express|fastify|koa|@koa\/router|restify|polka|@nestjs\/core)['"]|http\.createServer\(|createServer\(\s*\(req/,
    problem: 'A separate HTTP server/router bypasses Basalt API enforcement (auth, validation, limits, edge check).',
    fix: 'Define endpoints with createApi() from @basalt/api and run it with serve(api).',
  },
  {
    id: 'any-response-schema',
    severity: 'high',
    pattern: /response:\s*z\.(any|unknown)\(\)|response:\s*z\.object\([^)]*\)\.(passthrough|loose)\(\)|response:\s*z\.record\(/,
    problem: 'The response schema lets any field through, so internal columns can leak.',
    fix: 'List exactly the fields clients may see in the response schema.',
  },
  {
    id: 'public-write-route',
    severity: 'medium',
    pattern: /\.(post|put|patch|delete)\(\s*['"`][^'"`]+['"`]\s*,\s*\{[^}]*auth:\s*['"]public['"]/s,
    problem: 'A write route is public (anyone, no sign-in).',
    fix: 'Confirm it must be public; otherwise remove auth: \'public\'. If public, set a tight rateLimit and validate strictly.',
  },
  {
    id: 'edge-check-disabled',
    severity: 'critical',
    pattern: /edgeSecret:\s*(['"]{2}|undefined|null|false)|BASALT_EDGE_SECRET\s*=\s*['"`][^'"`]+['"`]|process\.env\.BASALT_EDGE_SECRET\s*=\s*/,
    problem: 'The edge check is disabled or the edge secret is hardcoded, so the backend can be called directly.',
    fix: 'Never set edgeSecret in code. api_setup manages BASALT_EDGE_SECRET; rotate it with api_rotate_edge_secret if exposed.',
  },
  {
    id: 'unsafe-outbound-fetch',
    severity: 'medium',
    pattern: /(?<![.\w])fetch\(\s*(body|query|params|input|req|ctx\.body|ctx\.query)\.\w+/,
    problem: 'A user-supplied URL is fetched with the global fetch (SSRF: internal network, cloud metadata).',
    fix: 'Use ctx.fetch(url) inside handlers.',
  },
  {
    id: 'error-detail-leak',
    severity: 'medium',
    pattern: /(message|error|detail)s?:\s*(err|error|e)\.(message|stack)|JSON\.stringify\(\s*(err|error|e)\s*\)/,
    problem: 'Internal error details are sent to clients.',
    fix: 'Throw errors.* with a user-safe message; unexpected errors are logged with a requestId and returned as a generic 500 automatically.',
  },
  {
    id: 'tls-verification-disabled',
    severity: 'critical',
    pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|rejectUnauthorized:\s*false/,
    problem: 'TLS certificate verification is disabled.',
    fix: 'Remove it. Fix the certificate or the URL instead.',
  },
  {
    id: 'dynamic-code-execution',
    severity: 'high',
    pattern: /\beval\(|new\s+Function\(|vm\.runIn\w+\(|exec(Sync)?\(\s*`[^`]*\$\{/,
    problem: 'Dynamic code or shell execution with interpolated input.',
    fix: 'Remove it; use explicit logic or execFile with an argument array.',
  },
  {
    id: 'env-file-edit',
    severity: 'high',
    pattern: /\.basalt\/[\w-]+\.env|writeFile[^\n]*\.env['"`]/,
    problem: 'Code reads or writes the platform-managed env file directly.',
    fix: 'Configuration is managed with the api_* MCP tools; code reads process.env only through createApi().',
  },
];

export function reviewApiCode(code: string, filename?: string): Finding[] {
  const lines = code.split('\n');
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (rule.skipPath && filename && rule.skipPath.test(filename)) continue;
    if (rule.pattern.flags.includes('s')) {
      const m = rule.pattern.exec(code);
      if (m) {
        const line = code.slice(0, m.index).split('\n').length;
        findings.push({ rule: rule.id, severity: rule.severity, line, snippet: (lines[line - 1] ?? '').trim().slice(0, 200), problem: rule.problem, fix: rule.fix });
      }
      continue;
    }
    lines.forEach((text, i) => {
      if (rule.pattern.test(text)) {
        findings.push({ rule: rule.id, severity: rule.severity, line: i + 1, snippet: text.trim().slice(0, 200), problem: rule.problem, fix: rule.fix });
      }
    });
  }
  // Auth rules too (tokens in storage, client-supplied user ids, own password hashing, ...).
  const all = [...findings, ...reviewAuthCode(code, filename)];
  const seen = new Set<string>();
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return all
    .filter((f) => {
      const k = `${f.rule}:${f.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
}

export type { Finding };
