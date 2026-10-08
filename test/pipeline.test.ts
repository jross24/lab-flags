import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SERVICE = 'flags';

interface Pipeline {
  readonly service: unknown;
  readonly requires: unknown;
}

function readPipeline(): Pipeline {
  return JSON.parse(readFileSync(new URL('../pipeline.json', import.meta.url), 'utf8')) as Pipeline;
}

describe('pipeline.json', () => {
  it('is valid JSON', () => {
    expect(() => readPipeline()).not.toThrow();
  });

  it(`names this service, ${SERVICE}`, () => {
    expect(readPipeline().service).toBe(SERVICE);
  });

  it('requires no other service, because the flags stack reads nothing from another service', () => {
    expect(readPipeline().requires).toEqual({});
  });
});
