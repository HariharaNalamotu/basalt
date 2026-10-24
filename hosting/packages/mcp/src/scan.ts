import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Kept in step with cloud/src/scan.ts (Basalt Cloud's standalone connector runs the same scan).
// Runs on the developer's machine, so the project's code never leaves it: only findings are sent.
//
// Guard's code scan: looks through the app's own folder for customer data kept
// somewhere other than Basalt, where none of Basalt's rules apply. Auth and API
// mistakes are covered by Basalt Auth's auth_review_code and the API's
// api_review_code, so they aren't repeated here.

export interface ScanFinding {
  rule: string;
  file: string;
  line: number;
  problem: string;
  fix: string;
}

interface Rule {
  id: string;
  pattern: RegExp;
  problem: string;
  fix: string;
}

// Browser storage keys that are clearly settings, not anyone's data.
const SETTING_KEY = /^\s*['"`](theme|dark_?mode|color_?scheme|lang|language|locale|sidebar\w*|tab|active_?tab|collapsed\w*|consent|cookie_?consent|onboard\w*|seen_\w+)['"`]/i;

const RULES: Rule[] = [
  {
    id: 'browser_storage',
    pattern: /\b(localStorage|sessionStorage)\s*\.\s*setItem\s*\(|\bindexedDB\s*\.\s*open\s*\(/,
    problem: "Data is saved in the browser, where anyone using that computer or any script on the page can read it, and it isn't backed up.",
    fix: 'Save it with Basalt (db.create or db.update in basalt.js) instead.',
  },
  {
    id: 'other_database',
    pattern: /(from\s+|require\(\s*)['"](firebase\/(firestore|database)|@firebase\/(firestore|database)|@supabase\/supabase-js|mongodb|mongoose|better-sqlite3|sqlite3?|@prisma\/client|@vercel\/(kv|postgres|blob)|@upstash\/redis|redis|ioredis|airtable|lowdb|nedb|pouchdb)['"]/,
    problem: "The app saves data in a second place that Basalt's rules don't protect.",
    fix: 'Keep all app data in Basalt and remove this library.',
  },
  {
    id: 'local_file_storage',
    pattern: /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\([^)\n]*\.(json|csv|txt|db|sqlite3?|ndjson)\b/,
    problem: 'Data is written to a file on the server, with no per-person rules and no backups.',
    fix: 'Save it with Basalt instead. For uploads use db.upload.',
  },
  {
    id: 'basalt_key_in_code',
    pattern: /\bbsk_[a-z0-9]{10}_[A-Za-z0-9_-]{20,}/,
    problem: "The app's Basalt key is pasted into the code. Anyone who sees the code could change the app's rules.",
    fix: 'Delete it from the code. Claude keeps it in .basalt/, which stays out of git.',
  },
  {
    id: 'host_token_in_code',
    pattern: /\bbht_[A-Za-z0-9_-]{40,}/,
    problem: "A Basalt Host workspace token is pasted into the code. Anyone who sees the code could deploy or delete the apps.",
    fix: 'Delete it from the code. It belongs only in the coding agent\'s MCP settings.',
  },
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.basalt', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.vercel', '.cache', 'coverage', 'vendor']);
const CODE = /\.(m?[jt]sx?|cjs|vue|svelte|astro|html?)$/;
const DATA_FILE = /\.(db|sqlite3?)$/;
const MAX_FILES = 2000;
const MAX_BYTES = 512 * 1024;

export function scanFolder(root: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  let seen = 0;
  let cut = false;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (cut) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (++seen > MAX_FILES) {
        cut = true;
        return;
      }
      const file = relative(root, full);
      if (DATA_FILE.test(entry.name)) {
        findings.push({
          rule: 'data_file',
          file,
          line: 0,
          problem: 'A database file sits in the app folder. It has no per-person rules and could end up in git.',
          fix: 'Move what it holds into Basalt and delete the file.',
        });
        continue;
      }
      if (!CODE.test(entry.name) || /\.min\.js$/.test(entry.name)) continue;
      if (statSync(full).size > MAX_BYTES) {
        findings.push({
          rule: 'scan_incomplete',
          file,
          line: 0,
          problem: `This file is over ${MAX_BYTES / 1024} KB, so it wasn't checked.`,
          fix: "If it's built output, keep it in a dist or build folder. Otherwise split it into smaller files.",
        });
        continue;
      }
      readFileSync(full, 'utf8')
        .split('\n')
        .forEach((text, i) => {
          for (const rule of RULES) {
            // Every match counts, so a harmless setting can't hide a real save on the same line.
            const hit = [...text.matchAll(new RegExp(rule.pattern.source, 'g'))].some(
              (m) => !(rule.id === 'browser_storage' && SETTING_KEY.test(text.slice(m.index + m[0].length))),
            );
            if (hit) findings.push({ rule: rule.id, file, line: i + 1, problem: rule.problem, fix: rule.fix });
          }
        });
    }
  };
  walk(root);

  if (existsSync(join(root, '.basalt'))) {
    const gi = join(root, '.gitignore');
    const ignored = existsSync(gi) && readFileSync(gi, 'utf8').split('\n').some((l) => ['.basalt', '.basalt/', '/.basalt', '/.basalt/'].includes(l.trim()));
    if (!ignored) {
      findings.push({
        rule: 'basalt_folder_not_ignored',
        file: '.gitignore',
        line: 0,
        problem: "The .basalt folder holds the app's key, and git would include it.",
        fix: 'Add a line with .basalt/ to .gitignore.',
      });
    }
  }
  if (cut) {
    findings.push({
      rule: 'scan_incomplete',
      file: '',
      line: 0,
      problem: `The folder has more than ${MAX_FILES} files, so only the first ${MAX_FILES} were checked.`,
      fix: 'Run the check from the app folder itself, not a folder above it.',
    });
  }
  return findings;
}
