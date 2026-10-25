import type { Config } from './config.js';

export type ConnectorOs = 'mac' | 'windows' | 'linux';

/**
 * The coding agent's connector config (the `.mcp.json` shape Claude Code reads), for one
 * workspace token. On native Windows, Claude Code needs `cmd /c` in front of npx, and Node
 * there doesn't resolve *.localhost names, so the one-laptop demo gives Windows the registry's
 * loopback port instead of registry.<root>.
 */
export function connectorConfig(cfg: Config, token: string, os: ConnectorOs) {
  const registry = os === 'windows' && cfg.registryLoopbackUrl ? cfg.registryLoopbackUrl : cfg.registryPublicUrl;
  const env = { BASALT_HOST_URL: cfg.hostPublicUrl, BASALT_HOST_TOKEN: token, BASALT_ROOT_DOMAIN: cfg.ROOT_DOMAIN, BASALT_REGISTRY_URL: registry };
  const npx = ['-y', '--registry', registry, '@basalt/host-mcp'];
  const server = os === 'windows' ? { type: 'stdio', command: 'cmd', args: ['/c', 'npx', ...npx], env } : { type: 'stdio', command: 'npx', args: npx, env };
  return { mcpServers: { basalt: server } };
}

/** The same, as one `claude mcp add` command line (macOS/Linux shells). */
export function connectorCommand(cfg: Config, token: string) {
  const { env, args } = connectorConfig(cfg, token, 'mac').mcpServers.basalt;
  return `claude mcp add basalt ${Object.entries(env).map(([k, v]) => `-e ${k}=${v}`).join(' ')} -- npx ${args.join(' ')}`;
}
