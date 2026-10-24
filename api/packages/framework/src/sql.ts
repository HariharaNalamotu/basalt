/**
 * Injection-proof SQL. Every interpolated value becomes a bind parameter ($1, $2, ...); it is
 * impossible to splice a value into the SQL text. Fragments built with `sql` can be nested for
 * conditional clauses:
 *
 *   const order = query.order === 'asc' ? sql`ASC` : sql`DESC`;
 *   await ctx.sql`SELECT * FROM todos WHERE done = ${query.done} ORDER BY created_at ${order}`;
 */
export class SqlQuery {
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}

  /** Renders to text with positional parameters, flattening nested fragments. */
  toQuery(): { text: string; values: unknown[] } {
    const values: unknown[] = [];
    const render = (q: SqlQuery): string => {
      let text = q.strings[0]!;
      q.values.forEach((v, i) => {
        if (v instanceof SqlQuery) text += render(v);
        else {
          values.push(v);
          text += `$${values.length}`;
        }
        text += q.strings[i + 1]!;
      });
      return text;
    };
    const text = render(this);
    if (values.length > 65_535) throw new Error('Too many SQL parameters (max 65535).');
    return { text, values };
  }
}

function assertValue(v: unknown) {
  if (v !== null && typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function') {
    throw new TypeError('A Promise was interpolated into SQL. Use the imported `sql` tag (not ctx.sql) to build fragments.');
  }
  if (typeof v === 'function') throw new TypeError('A function was interpolated into SQL.');
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
  values.forEach(assertValue);
  return new SqlQuery(strings, values);
}

/** Joins fragments (e.g. optional WHERE conditions) with a separator fragment. */
sql.join = (parts: SqlQuery[], separator: SqlQuery = sql`, `): SqlQuery => {
  if (parts.length === 0) return sql``;
  const strings: string[] = [''];
  const values: unknown[] = [];
  parts.forEach((part, i) => {
    if (i > 0) {
      values.push(separator);
      strings.push('');
    }
    values.push(part);
    strings.push('');
  });
  return new SqlQuery(strings, values);
};

export type QueryResult<T> = { rows: T[]; rowCount: number };
