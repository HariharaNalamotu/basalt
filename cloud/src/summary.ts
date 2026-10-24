import type { Contract, FieldSpec, TableSpec } from '../../data/src/index.ts';

// Turns the contract into the plain English the app's owner reads before they
// approve it. No jargon: this is for someone who has never written code.

function words(name: string): string {
  return name.replaceAll('_', ' ');
}

function plural(name: string): string {
  return words(name);
}

function describeField(name: string, spec: FieldSpec): string {
  let kind: string;
  switch (spec.type) {
    case 'text':
      kind = spec.format ? `a valid ${spec.format.replace('_', ' ')}` : `text, up to ${spec.maxLength} characters`;
      break;
    case 'integer':
      kind = 'a whole number';
      break;
    case 'number':
      kind = 'a number';
      break;
    case 'boolean':
      kind = 'yes or no';
      break;
    case 'timestamp':
      kind = 'a date and time';
      break;
    case 'user':
      kind = 'a person using the app';
      break;
  }
  const range =
    spec.min !== undefined && spec.max !== undefined
      ? ` from ${spec.min} to ${spec.max}`
      : spec.min !== undefined
        ? ` of at least ${spec.min}`
        : spec.max !== undefined
          ? ` of at most ${spec.max}`
          : '';
  return `${words(name)}: ${kind}${range}${spec.required ? ' (always needed)' : ''}`;
}

export function tableSummary(table: TableSpec): string[] {
  const things = plural(table.name);
  const lines = [`Each person can see and change only the ${things} they added themselves.`];
  if (table.shareWith) {
    lines.push(`The person picked in "${words(table.shareWith)}" can also see that one, but can't change it.`);
  }
  for (const group of table.unique ?? []) {
    lines.push(`No two ${things} can have the same ${group.map(words).join(' and ')}, whoever made them. Archived ones don't count.`);
  }
  lines.push(`Admins you approve can see and change all of them. Nobody else can see them.`);
  lines.push(`Nothing is ever permanently deleted: things can be archived and brought back.`);
  return lines;
}

export interface Summary {
  text: string;
  tables: { name: string; rules: string[]; fields: string[] }[];
}

export function summarize(contract: Contract): Summary {
  const tables = [...contract.tables.values()].map((t) => ({
    name: words(t.name),
    rules: tableSummary(t),
    fields: [...t.fields].map(([n, s]) => describeField(n, s)),
  }));
  const text = tables
    .map((t) => [`${t.name[0].toUpperCase()}${t.name.slice(1)}`, ...t.rules.map((r) => `- ${r}`), `  What's saved: ${t.fields.join('; ')}.`].join('\n'))
    .join('\n\n');
  return { text, tables };
}

// True when the new rules would let more people see something than the rules
// the owner already approved. Those changes always need the owner's yes.
export function loosens(approved: Contract | null, next: Contract): string[] {
  if (!approved) return ['These are the first rules for this app.'];
  const reasons: string[] = [];
  for (const t of next.tables.values()) {
    const before = approved.tables.get(t.name);
    if (!before) {
      if (t.shareWith) reasons.push(`New ${words(t.name)} can be seen by the person in "${words(t.shareWith)}".`);
      continue;
    }
    if (t.shareWith && t.shareWith !== before.shareWith) {
      reasons.push(`${words(t.name)} would be shown to the person in "${words(t.shareWith)}".`);
    }
  }
  return reasons;
}
