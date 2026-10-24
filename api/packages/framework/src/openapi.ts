import { z } from 'zod';

interface RouteLike {
  method: string;
  fullPath: string;
  config: {
    auth?: unknown;
    params?: z.ZodType;
    query?: z.ZodType;
    body?: z.ZodType | null;
    response: z.ZodType | null;
    status?: number;
    summary?: string;
    description?: string;
    tags?: string[];
  };
}

const schema = (s: z.ZodType, io: 'input' | 'output') => {
  try {
    return z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const ERROR = { $ref: '#/components/schemas/Error' };

/** OpenAPI 3.1 from route definitions: always in sync with what the server actually enforces. */
export function buildOpenApi(routes: RouteLike[], info: { title?: string; version?: string } = {}) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const path = r.fullPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const c = r.config;
    const parameters: unknown[] = [];
    for (const [where, s] of [['path', c.params], ['query', c.query]] as const) {
      if (!s) continue;
      const js = schema(s, 'input') as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, prop] of Object.entries(js.properties ?? {})) {
        parameters.push({ name, in: where, required: where === 'path' || (js.required ?? []).includes(name), schema: prop });
      }
    }
    const isPublic = c.auth === 'public';
    const success = c.response === null ? '204' : String(c.status ?? 200);
    const responses: Record<string, unknown> = {
      [success]: c.response === null ? { description: 'No content' } : { description: 'Success', content: { 'application/json': { schema: schema(c.response, 'output') } } },
      '400': { description: 'Invalid parameters', content: { 'application/json': { schema: ERROR } } },
      '429': { description: 'Rate limited', content: { 'application/json': { schema: ERROR } } },
    };
    if (!isPublic) {
      responses['401'] = { description: 'Not signed in', content: { 'application/json': { schema: ERROR } } };
      responses['403'] = { description: 'Not allowed', content: { 'application/json': { schema: ERROR } } };
    }
    if (c.params) responses['404'] = { description: 'Not found', content: { 'application/json': { schema: ERROR } } };
    if (c.body) responses['422'] = { description: 'Validation failed', content: { 'application/json': { schema: ERROR } } };
    paths[path] ??= {};
    paths[path]![r.method.toLowerCase()] = {
      summary: c.summary,
      description: c.description,
      tags: c.tags,
      parameters: parameters.length ? parameters : undefined,
      requestBody: c.body ? { required: true, content: { 'application/json': { schema: schema(c.body, 'input') } } } : undefined,
      responses,
      security: isPublic ? [] : [{ session: [] }, { bearer: [] }],
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: info.title ?? 'Basalt app API', version: info.version ?? '1.0.0' },
    paths,
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: '__Host-basalt_at' },
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                requestId: { type: 'string' },
                details: {},
              },
            },
          },
        },
      },
    },
  };
}
