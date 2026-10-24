// Packs the publishable @basalt/* packages for the platform registry, rewriting local file:
// dependencies to registry versions. Usage: node scripts/pack-basalt.mjs <repoRoot> <outDir>
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const packages = ['auth/packages/sdk', 'api/packages/framework', 'hosting/packages/mcp'];
for (const rel of packages) {
  const src = path.join(root, rel);
  const tmp = mkdtempSync(path.join(tmpdir(), 'pack-'));
  const pkg = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) if (String(spec).startsWith('file:')) pkg[field][name] = '^0.1.0';
  }
  delete pkg.private;
  delete pkg.devDependencies;
  delete pkg.scripts;
  if (rel === 'hosting/packages/mcp') {
    pkg.name = '@basalt/host-mcp';
    pkg.bin = { 'basalt-host-mcp': 'dist/main.js' };
    pkg.files = ['dist'];
  }
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg, null, 2));
  cpSync(path.join(src, 'dist'), path.join(tmp, 'dist'), { recursive: true });
  execFileSync('npm', ['pack', '--pack-destination', out], { cwd: tmp, stdio: 'ignore' });
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`packed ${packages.length} packages into ${out}`);
