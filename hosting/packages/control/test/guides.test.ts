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
});
