import { describe, expect, it } from 'vitest';
import { GUIDE_TOPICS, hostGuide } from '../src/guides.js';

describe('the agent guide', () => {
  it('teaches the Data block: rules in basalt.data.json, saving from the page through /_basalt/data, and the owner asked in plain words', () => {
    expect(GUIDE_TOPICS).toContain('data');
    const data = hostGuide('data', 'apps.dev');
    expect(data).toMatch(/basalt\.data\.json/);
    expect(data).toMatch(/\/_basalt\/data/);
    expect(data).toMatch(/export function basalt/);
    expect(data).toMatch(/plain/i);
    expect(data).toMatch(/host_data_check/);
  });

  it('sends the agent to the data topic from the workflow', () => {
    expect(hostGuide('workflow', 'apps.dev')).toMatch(/topic "data"|\*\*data\*\* topic/);
  });

  it('has a design topic with a palette from the business, the CSS starter and a phone and dark mode check before shipping', () => {
    expect(GUIDE_TOPICS).toContain('design');
    const design = hostGuide('design', 'apps.dev');
    expect(design).toMatch(/Brand from the business/);
    expect(design).toMatch(/--brand:/);
    expect(design).toMatch(/prefers-color-scheme:dark/);
    expect(design).toMatch(/\.slot\[aria-pressed="true"\]/);
    expect(design).toMatch(/viewport: "phone"/);
    expect(design).toMatch(/colorScheme: "dark"/);
    expect(design).not.toMatch(/\u2014/); // no em dashes in anything shown to people
  });

  it('sends the agent to the design topic before pages and its visual check before reporting', () => {
    const w = hostGuide('workflow', 'apps.dev');
    expect(w).toMatch(/\*\*design\*\* topic/);
    expect(w).toMatch(/viewport: "phone"/);
  });

  it("tells the agent not to install packages on the human's computer", () => {
    expect(hostGuide('workflow', 'apps.dev')).toMatch(/No local install is needed/);
  });

  it('only uses Data routes the edge lets through (it 404s anything else under /_basalt/data)', () => {
    // Same allow-list as hosting/packages/edge/src/server.ts (DATA_POST).
    const allowed = /^\/v1\/(data\/(get|list|create|update|archive|restore)|files|files\/link)$/;
    const data = hostGuide('data', 'apps.dev');
    const ops = [...data.matchAll(/op\('([a-z/]+)'/g)].map((m) => `/v1/data/${m[1]}`);
    const calls = [...data.matchAll(/call\('(\/v1\/[a-z/]*[a-z])'/g)].map((m) => m[1]);
    expect(ops.length + calls.length).toBeGreaterThan(6);
    for (const path of [...ops, ...calls]) expect(path, path).toMatch(allowed);
  });

  it('warns against making personal details unique (a clash tells anyone the value is taken)', () => {
    expect(hostGuide('data', 'apps.dev')).toMatch(/Don't make personal details unique/);
  });
});
