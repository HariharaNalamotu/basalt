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

  it("has the agent give a business owner a screen of everyone's entries, made an admin by their email", () => {
    const data = hostGuide('data', 'apps.dev');
    expect(data).toMatch(/owner.{0,80}(all|every)/i);
    expect(data).toMatch(/host_data_admin[^.]*email/);
    expect(data).toMatch(/sign up/i);
  });

  it('sends the agent to the data topic from the workflow', () => {
    expect(hostGuide('workflow', 'apps.dev')).toMatch(/topic "data"|\*\*data\*\* topic/);
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
