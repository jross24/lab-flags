// The context value `namespace` lets several copies of this service live in one account.
// The Dev stage reads it. The pipeline stages never do. See "Namespaces" in the README.

// The tag that marks every resource of a namespaced copy. It helps to find the resources and the cost of a copy.
export const NAMESPACE_TAG = 'lab-namespace';

// A letter first, then letters a-z, digits and hyphens. At most 20 characters. The code also refuses a hyphen at the end.
// The limit keeps the longest stack name (lab-flags-<namespace>) far below the limit of CloudFormation.
const NAMESPACE = /^[a-z][a-z0-9-]{0,19}$/;

export function parseNamespace(value: unknown): string {
  if (typeof value !== 'string' || !NAMESPACE.test(value) || value.endsWith('-')) {
    throw new Error(
      `Context value namespace must be 1 to 20 characters: a letter a-z first, then letters a-z, digits and -, and no - at the end. Got ${JSON.stringify(value)}. Example: -c namespace=my-test`,
    );
  }
  return value;
}

// The names that must be unique in an account. Everything else in the stack gets its name from CloudFormation.
export interface FlagsNames {
  readonly stackName: string;
  // The AppConfig application and the deployment strategy. AppConfig does not need unique names, but a person reads them in the console.
  readonly applicationName: string;
  readonly strategyName: string;
  // The SSM parameters are <prefix>/application-id, /environment-id, /profile-id, /version and /state/<flag-name>. The services and the tests read them.
  readonly parameterPrefix: string;
}

// With no namespace the names are the names of the baseline copy of the account. They never change.
export function namesFor(namespace?: string): FlagsNames {
  if (namespace === undefined) {
    return { stackName: 'lab-flags', applicationName: 'lab-flags', strategyName: 'lab-flags', parameterPrefix: '/lab/flags' };
  }
  const valid = parseNamespace(namespace);
  return {
    stackName: `lab-flags-${valid}`,
    applicationName: `lab-flags-${valid}`,
    strategyName: `lab-flags-${valid}`,
    parameterPrefix: `/lab/ns/${valid}/flags`,
  };
}
