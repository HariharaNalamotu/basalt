// The only way this app reads or saves data.
export type Row = { id: string; owner_id: string; created_at: string; [field: string]: unknown };
type Page = { rows: Row[]; next?: string };

export class DataError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

async function op<T>(name: string, body: unknown): Promise<T> {
  const res = await fetch('/_basalt/data/v1/data/' + name, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new DataError(json.error.message, json.error.code);
  return json.data as T;
}

export const db = {
  create: (table: string, input: Record<string, unknown>) => op<Row>('create', { table, input }),
  archive: (table: string, id: string) => op<unknown>('archive', { table, id }),
  listAll: async (table: string): Promise<Row[]> => {
    const rows: Row[] = [];
    let after: string | undefined;
    do {
      const page: Page = await op<Page>('list', { table, limit: 100, ...(after ? { after } : {}) });
      rows.push(...page.rows);
      after = page.next;
    } while (after && rows.length < 5000);
    return rows;
  },
};
