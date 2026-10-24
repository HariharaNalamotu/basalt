// Runs the security SQL files in sql/ without needing psql installed.
// Supports exactly the psql features those files use: \set lines (ignored),
// :'name' and :"name" variables, and \gexec. Variables are only filled in
// outside quotes, comments and $$ bodies, the same as psql.

import pg from 'pg';

function literal(value: string): string {
  if (value.includes('\u0000')) throw new Error('Refusing a value with a null byte');
  return `'${value.replaceAll("'", "''")}'`;
}

function ident(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error(`Refusing unsafe role or object name: ${value}`);
  return `"${value}"`;
}

export interface Statement {
  sql: string;
  gexec: boolean;
}

export function splitSql(text: string, vars: Record<string, string>): Statement[] {
  const out: Statement[] = [];
  let buf = '';
  let i = 0;
  const n = text.length;

  const push = (gexec: boolean) => {
    if (buf.trim()) out.push({ sql: buf.trim(), gexec });
    buf = '';
  };

  while (i < n) {
    const c = text[i];
    const rest = text.slice(i);

    // psql meta-commands at the start of a line.
    if (c === '\\' && (i === 0 || text[i - 1] === '\n' || /^\s*$/.test(text.slice(text.lastIndexOf('\n', i - 1) + 1, i)))) {
      const end = text.indexOf('\n', i);
      const line = text.slice(i, end === -1 ? n : end).trim();
      if (line.startsWith('\\set')) {
        i = end === -1 ? n : end + 1;
        continue;
      }
    }
    if (rest.startsWith('\\gexec')) {
      push(true);
      i += 6;
      continue;
    }
    if (rest.startsWith('--')) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      buf += '\n';
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unclosed comment');
      i = end + 2;
      continue;
    }
    if (c === "'" || (c === '"' && text[i - 1] !== ':')) {
      // Quoted string or identifier, '' or "" escapes a quote.
      let j = i + 1;
      while (j < n) {
        if (text[j] === c) {
          if (text[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= n) throw new Error('Unclosed quote');
      buf += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = text.indexOf(tag, i + tag.length);
      if (end === -1) throw new Error(`Unclosed ${tag} body`);
      buf += text.slice(i, end + tag.length);
      i = end + tag.length;
      continue;
    }
    const variable = /^:(['"])([a-z_][a-z0-9_]*)\1/.exec(rest);
    if (variable && text[i - 1] !== ':') {
      const name = variable[2];
      if (!Object.hasOwn(vars, name)) throw new Error(`Missing SQL variable ${name}`);
      buf += variable[1] === "'" ? literal(vars[name]) : ident(vars[name]);
      i += variable[0].length;
      continue;
    }
    if (c === ';') {
      push(false);
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  push(false);
  return out;
}

export async function runSql(client: pg.Client, text: string, vars: Record<string, string>): Promise<void> {
  for (const stmt of splitSql(text, vars)) {
    const res = await client.query({ text: stmt.sql, rowMode: 'array' });
    if (!stmt.gexec) continue;
    for (const row of res.rows as unknown[][]) {
      for (const cell of row) if (typeof cell === 'string' && cell.trim()) await client.query(cell);
    }
  }
}
