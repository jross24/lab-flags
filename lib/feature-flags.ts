// The logic for the flag file: the types, the AppConfig content, the checks, and the removeBy date.
// The data is in flags.ts. This file has no data, so a change of a flag never touches it.

export const STAGE_NAMES = ['test', 'staging', 'production'] as const;
export type FlagStageName = (typeof STAGE_NAMES)[number];

export interface FlagDefinition {
  readonly description: string;
  // The person or team that removes the flag. A GitHub user name is enough.
  readonly owner: string;
  // The last day on which the flag may exist, as YYYY-MM-DD in UTC. After that day the tests fail.
  readonly removeBy: string;
  readonly values: Readonly<Record<FlagStageName, boolean>>;
}

export type FlagSet = Readonly<Record<string, FlagDefinition>>;

// The AppConfig feature flag format, version 1. AppConfig refuses other fields in a hosted configuration of this type,
// so the owner and the removeBy date stay in the flag file only.
export interface FeatureFlagContent {
  readonly version: '1';
  readonly flags: Record<string, { name: string; description: string }>;
  readonly values: Record<string, { enabled: boolean }>;
}

// A key starts with a lower case letter. AppConfig allows letters, digits, - and _, at most 64 characters.
const FLAG_KEY = /^[a-z][a-zA-Z0-9_-]{0,63}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isRealDate(text: string): boolean {
  const match = DATE.exec(text);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function buildFeatureFlagContent(flags: FlagSet, stage: FlagStageName): FeatureFlagContent {
  const content: FeatureFlagContent = { version: '1', flags: {}, values: {} };
  for (const [key, flag] of Object.entries(flags)) {
    content.flags[key] = { name: key, description: flag.description };
    content.values[key] = { enabled: flag.values[stage] };
  }
  return content;
}

// The declared state of each flag in one stage, as the word "on" or "off". The stack writes it to the SSM parameter
// /lab/flags/state/<flag-name>. The end-to-end suite reads it and checks that the product shows the same state.
export type FlagState = 'on' | 'off';

export function buildFlagStates(flags: FlagSet, stage: FlagStageName): Record<string, FlagState> {
  const states: Record<string, FlagState> = {};
  for (const [key, flag] of Object.entries(flags)) states[key] = flag.values[stage] ? 'on' : 'off';
  return states;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Returns one sentence for each reason why AppConfig could refuse the content. An empty list means that it is valid.
export function findContentProblems(content: unknown): string[] {
  if (!isRecord(content)) return ['The content is not an object.'];
  const problems: string[] = [];
  if (content['version'] !== '1') problems.push('The content needs "version": "1".');
  const flags = content['flags'];
  const values = content['values'];
  if (!isRecord(flags) || !isRecord(values)) {
    problems.push('The content needs the objects "flags" and "values".');
    return problems;
  }
  for (const [key, flag] of Object.entries(flags)) {
    if (!FLAG_KEY.test(key)) problems.push(`The flag key "${key}" is not valid. Use a lower case letter first, then letters, digits, - and _.`);
    if (!isRecord(flag) || flag['name'] !== key) problems.push(`The flag "${key}" needs a "name" that is equal to its key.`);
    if (!isRecord(values[key]) || typeof (values[key] as Record<string, unknown>)['enabled'] !== 'boolean') {
      problems.push(`The flag "${key}" needs a value with "enabled" set to true or false.`);
    }
  }
  for (const key of Object.keys(values)) {
    if (!(key in flags)) problems.push(`The value "${key}" has no flag with the same key.`);
  }
  return problems;
}

// Checks the flag file at run time. The types check it at build time, but a cast can hide a missing field.
export function findFlagProblems(flags: unknown): string[] {
  if (!isRecord(flags)) return ['The flag file is not an object.'];
  const problems: string[] = [];
  for (const [key, flag] of Object.entries(flags)) {
    if (!FLAG_KEY.test(key)) problems.push(`The flag key "${key}" is not valid. Use a lower case letter first, then letters, digits, - and _.`);
    if (!isRecord(flag)) {
      problems.push(`The flag "${key}" is not an object.`);
      continue;
    }
    for (const field of ['description', 'owner'] as const) {
      const value = flag[field];
      if (typeof value !== 'string' || value.trim() === '') problems.push(`The flag "${key}" needs a ${field} with text.`);
    }
    const removeBy = flag['removeBy'];
    if (typeof removeBy !== 'string' || !isRealDate(removeBy)) {
      problems.push(`The flag "${key}" needs a removeBy date in the form YYYY-MM-DD.`);
    }
    const values = flag['values'];
    if (!isRecord(values)) {
      problems.push(`The flag "${key}" needs values for ${STAGE_NAMES.join(', ')}.`);
      continue;
    }
    for (const stage of STAGE_NAMES) {
      if (typeof values[stage] !== 'boolean') problems.push(`The flag "${key}" needs the value ${stage} set to true or false.`);
    }
    for (const stage of Object.keys(values)) {
      if (!(STAGE_NAMES as readonly string[]).includes(stage)) problems.push(`The flag "${key}" has the unknown stage "${stage}".`);
    }
  }
  return problems;
}

export interface ExpiredFlag {
  readonly flag: string;
  readonly owner: string;
  readonly removeBy: string;
}

// today is an argument, so a test can set the date. A flag is expired on the day after its removeBy date.
export function findExpiredFlags(flags: FlagSet, today: string): ExpiredFlag[] {
  if (!isRealDate(today)) throw new Error(`The date for the removeBy check must look like YYYY-MM-DD. Got ${JSON.stringify(today)}.`);
  return Object.entries(flags)
    .filter(([, flag]) => flag.removeBy < today)
    .map(([key, flag]) => ({ flag: key, owner: flag.owner, removeBy: flag.removeBy }));
}

export function assertNoExpiredFlags(flags: FlagSet, today: string): void {
  const expired = findExpiredFlags(flags, today);
  if (expired.length === 0) return;
  const lines = expired.map(
    (e) => `The flag "${e.flag}" (owner ${e.owner}) is past its removeBy date ${e.removeBy}. Today is ${today}.`,
  );
  throw new Error(
    `${lines.join('\n')}\nRemove the flag from lib/flags.ts, or move its removeBy date and give the reason in the pull request.`,
  );
}
