import type { FlagSet } from './feature-flags.ts';

// The one file of flags. Add, change or remove a flag here, in a pull request. The pipeline releases the change.
// Each flag has a description, an owner, a removeBy date (YYYY-MM-DD, UTC) and a value for each stage.
// A test fails when a flag is past its removeBy date. See the README.
export const FLAGS = {
  'show-discounts': {
    description: 'The catalogue adds an optional discount to each product, and the web page shows it.',
    owner: 'jross24',
    removeBy: '2027-01-08',
    values: { test: false, staging: false, production: false },
  },
} as const satisfies FlagSet;
