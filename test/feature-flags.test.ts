import { describe, expect, it } from 'vitest';
import {
  STAGE_NAMES,
  assertNoExpiredFlags,
  buildFeatureFlagContent,
  buildFlagStates,
  findContentProblems,
  findExpiredFlags,
  findFlagProblems,
  todayUtc,
} from '../lib/feature-flags.ts';
import type { FlagSet } from '../lib/feature-flags.ts';
import { FLAGS } from '../lib/flags.ts';

// A fixed set of flags. The tests that need a date use this set and an injected date, so they never read the clock.
const FIXTURE: FlagSet = {
  'alpha-flag': {
    description: 'The first flag.',
    owner: 'team-a',
    removeBy: '2027-01-08',
    values: { test: true, staging: false, production: false },
  },
  beta_flag: {
    description: 'The second flag.',
    owner: 'team-b',
    removeBy: '2027-03-01',
    values: { test: false, staging: false, production: true },
  },
};

const ALL_ON = { test: true, staging: true, production: true };

describe('buildFeatureFlagContent', () => {
  it('makes AppConfig feature flag JSON for each stage of the real flags', () => {
    for (const stage of STAGE_NAMES) {
      const content = buildFeatureFlagContent(FLAGS, stage);
      expect(findContentProblems(content), `stage ${stage}`).toEqual([]);
    }
  });

  it('makes the format version 1 with one entry in flags and one in values for each flag', () => {
    const content = buildFeatureFlagContent(FIXTURE, 'test');
    expect(content.version).toBe('1');
    expect(Object.keys(content.flags)).toEqual(['alpha-flag', 'beta_flag']);
    expect(Object.keys(content.values)).toEqual(['alpha-flag', 'beta_flag']);
    expect(content.flags['alpha-flag']).toEqual({ name: 'alpha-flag', description: 'The first flag.' });
  });

  it('takes the value of the stage', () => {
    expect(buildFeatureFlagContent(FIXTURE, 'test').values).toEqual({
      'alpha-flag': { enabled: true },
      beta_flag: { enabled: false },
    });
    expect(buildFeatureFlagContent(FIXTURE, 'production').values).toEqual({
      'alpha-flag': { enabled: false },
      beta_flag: { enabled: true },
    });
  });

  it('keeps the owner and the removeBy date out of the content, because AppConfig has no such fields', () => {
    const text = JSON.stringify(buildFeatureFlagContent(FIXTURE, 'test'));
    expect(text).not.toContain('team-a');
    expect(text).not.toContain('2027-01-08');
  });

  it('gives the same text on each call, so an unchanged flag file makes no new version', () => {
    expect(JSON.stringify(buildFeatureFlagContent(FIXTURE, 'staging'))).toBe(
      JSON.stringify(buildFeatureFlagContent(FIXTURE, 'staging')),
    );
  });
});

describe('buildFlagStates', () => {
  it('gives on for a flag that is true in the stage and off for a flag that is false', () => {
    expect(buildFlagStates(FIXTURE, 'test')).toEqual({ 'alpha-flag': 'on', beta_flag: 'off' });
    expect(buildFlagStates(FIXTURE, 'staging')).toEqual({ 'alpha-flag': 'off', beta_flag: 'off' });
    expect(buildFlagStates(FIXTURE, 'production')).toEqual({ 'alpha-flag': 'off', beta_flag: 'on' });
  });

  it('has one entry for each flag, in the order of the flag file', () => {
    expect(Object.keys(buildFlagStates(FIXTURE, 'test'))).toEqual(['alpha-flag', 'beta_flag']);
  });

  it('follows the same value as the AppConfig content, so the two cannot disagree', () => {
    for (const stage of STAGE_NAMES) {
      const content = buildFeatureFlagContent(FIXTURE, stage);
      const states = buildFlagStates(FIXTURE, stage);
      for (const key of Object.keys(FIXTURE)) {
        expect(states[key], `${key} in ${stage}`).toBe(content.values[key]?.enabled === true ? 'on' : 'off');
      }
    }
  });

  it('gives off for the real flag show-discounts in every stage while the flag file has it off', () => {
    for (const stage of STAGE_NAMES) expect(buildFlagStates(FLAGS, stage)['show-discounts']).toBe(FLAGS['show-discounts'].values[stage] ? 'on' : 'off');
  });
});

describe('findContentProblems', () => {
  const good = () => JSON.parse(JSON.stringify(buildFeatureFlagContent(FIXTURE, 'test'))) as Record<string, unknown>;

  it('accepts content that the builder made', () => {
    expect(findContentProblems(good())).toEqual([]);
  });

  it('refuses content that is not an object', () => {
    expect(findContentProblems('text')).not.toEqual([]);
    expect(findContentProblems(null)).not.toEqual([]);
  });

  it('refuses a wrong format version', () => {
    expect(findContentProblems({ ...good(), version: '2' }).join(' ')).toContain('version');
  });

  it('refuses a flag key that AppConfig does not accept', () => {
    const content = good();
    (content['flags'] as Record<string, unknown>)['Bad Key'] = { name: 'Bad Key' };
    (content['values'] as Record<string, unknown>)['Bad Key'] = { enabled: false };
    expect(findContentProblems(content).join(' ')).toContain('Bad Key');
  });

  it('refuses a flag with no value', () => {
    const content = good();
    delete (content['values'] as Record<string, unknown>)['alpha-flag'];
    expect(findContentProblems(content).join(' ')).toContain('alpha-flag');
  });

  it('refuses a value for a flag that is not defined', () => {
    const content = good();
    (content['values'] as Record<string, unknown>)['ghost'] = { enabled: true };
    expect(findContentProblems(content).join(' ')).toContain('ghost');
  });

  it('refuses a value that is not true or false', () => {
    const content = good();
    (content['values'] as Record<string, unknown>)['alpha-flag'] = { enabled: 'yes' };
    expect(findContentProblems(content).join(' ')).toContain('alpha-flag');
  });

  it('refuses a flag whose name is not its key', () => {
    const content = good();
    (content['flags'] as Record<string, unknown>)['alpha-flag'] = { name: 'other' };
    expect(findContentProblems(content).join(' ')).toContain('alpha-flag');
  });
});

describe('findFlagProblems', () => {
  it('finds no problem in the real flags', () => {
    expect(findFlagProblems(FLAGS)).toEqual([]);
  });

  it('finds no problem in the fixture', () => {
    expect(findFlagProblems(FIXTURE)).toEqual([]);
  });

  it('has at least one flag, so the file is not empty by mistake', () => {
    expect(Object.keys(FLAGS).length).toBeGreaterThan(0);
  });

  it('names the flag and the field for each missing field', () => {
    const broken = { 'no-owner': { description: 'x', removeBy: '2027-01-08', values: ALL_ON } };
    const problems = findFlagProblems(broken);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no-owner');
    expect(problems[0]).toContain('owner');
  });

  it('refuses an empty description and an empty owner', () => {
    const broken = { f: { description: ' ', owner: '', removeBy: '2027-01-08', values: ALL_ON } };
    const problems = findFlagProblems(broken).join(' ');
    expect(problems).toContain('description');
    expect(problems).toContain('owner');
  });

  it('refuses a removeBy that is not a real date', () => {
    for (const removeBy of ['soon', '2027-13-01', '2027-02-30', '08-01-2027', '']) {
      const broken = { f: { description: 'x', owner: 'o', removeBy, values: ALL_ON } };
      expect(findFlagProblems(broken).join(' '), removeBy).toContain('removeBy');
    }
  });

  it('refuses a missing stage value, a value that is not a boolean and an unknown stage', () => {
    const missing = { f: { description: 'x', owner: 'o', removeBy: '2027-01-08', values: { test: true, staging: true } } };
    expect(findFlagProblems(missing).join(' ')).toContain('production');
    const text = { f: { description: 'x', owner: 'o', removeBy: '2027-01-08', values: { ...ALL_ON, test: 'on' } } };
    expect(findFlagProblems(text).join(' ')).toContain('test');
    const extra = { f: { description: 'x', owner: 'o', removeBy: '2027-01-08', values: { ...ALL_ON, dev: true } } };
    expect(findFlagProblems(extra).join(' ')).toContain('dev');
  });

  it('refuses a flag key that AppConfig does not accept', () => {
    const broken = { 'Bad Key': { description: 'x', owner: 'o', removeBy: '2027-01-08', values: ALL_ON } };
    expect(findFlagProblems(broken).join(' ')).toContain('Bad Key');
  });
});

describe('the removeBy date', () => {
  it('lists no flag on the day before the date', () => {
    expect(findExpiredFlags(FIXTURE, '2027-01-07')).toEqual([]);
  });

  it('lists no flag on the removeBy day itself', () => {
    expect(findExpiredFlags(FIXTURE, '2027-01-08')).toEqual([]);
  });

  it('lists a flag on the day after the date', () => {
    expect(findExpiredFlags(FIXTURE, '2027-01-09')).toEqual([
      { flag: 'alpha-flag', owner: 'team-a', removeBy: '2027-01-08' },
    ]);
  });

  it('lists every flag that is past its date', () => {
    expect(findExpiredFlags(FIXTURE, '2027-04-01').map((e) => e.flag)).toEqual(['alpha-flag', 'beta_flag']);
  });

  it('fails with a message that names the flag, its date and its owner', () => {
    expect(() => assertNoExpiredFlags(FIXTURE, '2027-01-09')).toThrow(/alpha-flag/);
    expect(() => assertNoExpiredFlags(FIXTURE, '2027-01-09')).toThrow(/2027-01-08/);
    expect(() => assertNoExpiredFlags(FIXTURE, '2027-01-09')).toThrow(/team-a/);
    expect(() => assertNoExpiredFlags(FIXTURE, '2027-01-09')).not.toThrow(/beta_flag/);
  });

  it('names every expired flag in one message', () => {
    expect(() => assertNoExpiredFlags(FIXTURE, '2027-04-01')).toThrow(/alpha-flag[\s\S]*beta_flag/);
  });

  it('does not fail on the removeBy day', () => {
    expect(() => assertNoExpiredFlags(FIXTURE, '2027-01-08')).not.toThrow();
  });

  it('refuses a "today" that is not a date, so a bad clock cannot hide an expired flag', () => {
    expect(() => findExpiredFlags(FIXTURE, 'today')).toThrow(/date/);
  });

  it('reads today from a Date in UTC', () => {
    expect(todayUtc(new Date('2027-01-08T23:59:59Z'))).toBe('2027-01-08');
    expect(todayUtc(new Date('2027-01-09T00:00:00Z'))).toBe('2027-01-09');
  });

  // The test that blocks a pull request and a release when a real flag is past its date.
  it('finds no real flag past its removeBy date today', () => {
    assertNoExpiredFlags(FLAGS, todayUtc(new Date()));
  });
});
