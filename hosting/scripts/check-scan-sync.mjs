// The connector's local data scan (hosting/packages/mcp/src/scan.ts) must stay the same as Basalt
// Cloud's (cloud/src/scan.ts), apart from comments and the host-token rule only hosting has.
import { readFileSync } from 'node:fs';

const code = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8').split('\n').filter((l) => !l.startsWith('//')).join('\n');
const cloud = code('cloud/src/scan.ts');
const host = code('hosting/packages/mcp/src/scan.ts').replace(/  \{\n    id: 'host_token_in_code',[\s\S]*?\n  \},\n/, '');
if (cloud !== host) {
  console.error('hosting/packages/mcp/src/scan.ts has drifted from cloud/src/scan.ts. Copy the change across.');
  process.exit(1);
}
console.log('local scan matches Basalt Cloud');
