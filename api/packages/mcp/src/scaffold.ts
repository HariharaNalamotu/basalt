/** Complete, working starter files. Everything is wired; the agent only adds more routes. */
export function scaffold(app: string): Record<string, string> {
  const env = `.basalt/${app}.env`;
  return {
    'server/index.ts': `import { createApi } from '@basalt/api';
import { serve } from '@basalt/api/serve';
import { registerTodoRoutes } from './routes/todos.ts';

// Everything (auth, database, Redis, edge secret, limits) comes from the environment that the
// api_setup MCP tool provisioned. Change behaviour with the api_* tools, not here.
const api = createApi();

registerTodoRoutes(api);

serve(api);
`,
    'server/routes/todos.ts': `import { errors, z, type Api } from '@basalt/api';

const Todo = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  createdAt: z.date(),
});

type TodoRow = { id: string; title: string; done: boolean; created_at: Date };
const toTodo = (r: TodoRow) => ({ id: r.id, title: r.title, done: r.done, createdAt: r.created_at });

export function registerTodoRoutes(api: Api) {
  api.get('/todos', {
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
    response: z.array(Todo),
    summary: "List the signed-in user's todos",
  }, async ({ sql, query }) => {
    const rows = await sql<TodoRow>\`SELECT * FROM todos ORDER BY created_at DESC LIMIT \${query.limit}\`;
    return rows.map(toTodo);
  });

  api.get('/todos/:id', {
    params: z.object({ id: z.uuid() }),
    response: Todo,
  }, async ({ sql, params }) => toTodo(await sql.one<TodoRow>\`SELECT * FROM todos WHERE id = \${params.id}\`));

  api.post('/todos', {
    body: z.object({ title: z.string().trim().min(1).max(200) }),
    response: Todo,
    status: 201,
  }, async ({ sql, body }) => toTodo(await sql.one<TodoRow>\`INSERT INTO todos (title) VALUES (\${body.title}) RETURNING *\`));

  api.patch('/todos/:id', {
    params: z.object({ id: z.uuid() }),
    body: z.object({ title: z.string().trim().min(1).max(200).optional(), done: z.boolean().optional() }),
    response: Todo,
  }, async ({ sql, params, body }) =>
    toTodo(await sql.one<TodoRow>\`
      UPDATE todos SET title = COALESCE(\${body.title ?? null}, title), done = COALESCE(\${body.done ?? null}, done)
      WHERE id = \${params.id} RETURNING *\`));

  api.delete('/todos/:id', {
    params: z.object({ id: z.uuid() }),
    response: null,
  }, async ({ sql, params }) => {
    const r = await sql.exec\`DELETE FROM todos WHERE id = \${params.id}\`;
    if (r.rowCount === 0) throw errors.notFound('Todo not found.');
  });
}
`,
    'db/migrations/001_todos.sql': `CREATE TABLE todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL DEFAULT basalt_auth.uid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX todos_owner_created_idx ON todos (owner_id, created_at DESC);
SELECT basalt_auth.protect('todos');
`,
    'src/lib/api.ts': `import { createAuthClient } from '@basalt/auth/client';
import { createApiClient } from '@basalt/api/client';

export const auth = createAuthClient();
export const api = createApiClient({ auth });
`,
    'package.json (scripts to merge)': JSON.stringify(
      {
        type: 'module',
        scripts: {
          'db:migrate': `node --env-file=${env} node_modules/@basalt/api/dist/migrate-cli.js`,
          'dev:api': `node --env-file=${env} --watch server/index.ts`,
          'dev:edge': `node --env-file=${env} node_modules/@basalt/api/dist/dev-edge-cli.js --frontend http://localhost:5173`,
        },
        dependencies: { '@basalt/api': '^0.1.0', '@basalt/auth': '^0.1.0' },
      },
      null,
      2,
    ),
  };
}
