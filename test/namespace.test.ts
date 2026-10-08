import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { CloudAssembly, CloudFormationStackArtifact } from 'aws-cdk-lib/cx-api';
import { createApp } from '../lib/app.ts';
import { NAMESPACE_TAG, namesFor, parseNamespace } from '../lib/namespace.ts';

// Twelve digits that are not a part of a longer number or of a hex hash.
const ACCOUNT_ID = /(?<![0-9a-f])[0-9]{12}(?![0-9a-f])/i;

function devStack(context: Record<string, unknown>): CloudFormationStackArtifact {
  const assembly: CloudAssembly = createApp({ dev: 'true', ...context }).synth();
  const stacks = assembly.stacksRecursively;
  expect(stacks).toHaveLength(1);
  return stacks[0] as CloudFormationStackArtifact;
}

function parameterNames(stack: CloudFormationStackArtifact): string[] {
  const template = Template.fromJSON(stack.template);
  return Object.values(template.findResources('AWS::SSM::Parameter'))
    .map((resource) => (resource.Properties as { Name: string }).Name)
    .sort();
}

describe('parseNamespace', () => {
  it.each(['a', 'laptop-test', 'pr-12', 'a--b', 'a1', 'abcdefghijklmnopqrst'])('accepts %j', (value) => {
    expect(parseNamespace(value)).toBe(value);
  });

  it.each(['', 'A', '1abc', '-abc', 'abc-', 'a_b', 'a.b', 'a b', 'a/b', 'abc\n', 'abcdefghijklmnopqrstu', 12, true, null, ['abc']])(
    'rejects %j with a clear message',
    (value) => {
      expect(() => parseNamespace(value)).toThrow(/namespace must be 1 to 20 characters/);
      expect(() => parseNamespace(value)).toThrow(/Example: -c namespace=my-test/);
    },
  );
});

describe('namesFor', () => {
  it('gives the names of the baseline copy when there is no namespace', () => {
    expect(namesFor()).toEqual({
      stackName: 'lab-flags',
      applicationName: 'lab-flags',
      strategyName: 'lab-flags',
      parameterPrefix: '/lab/flags',
    });
  });

  it('gives each name its own namespace', () => {
    expect(namesFor('my-test')).toEqual({
      stackName: 'lab-flags-my-test',
      applicationName: 'lab-flags-my-test',
      strategyName: 'lab-flags-my-test',
      parameterPrefix: '/lab/ns/my-test/flags',
    });
  });

  it('refuses a namespace that parseNamespace refuses', () => {
    expect(() => namesFor('Bad_Name')).toThrow(/namespace must be 1 to 20 characters/);
  });

  it('keeps the longest names inside the limits of CloudFormation and SSM', () => {
    const names = namesFor('abcdefghijklmnopqrst');
    expect(names.stackName.length).toBeLessThanOrEqual(128);
    expect(`${names.parameterPrefix}/environment-id`.length).toBeLessThanOrEqual(1011);
    // The flag key has at most 64 characters, and "/state/" has 7.
    expect(`${names.parameterPrefix}/state/${'a'.repeat(64)}`.length).toBeLessThanOrEqual(1011);
  });
});

describe('the app with dev=true and a namespace', () => {
  const stack = devStack({ namespace: 'my-test' });

  it('has only the stage Dev and one stack, so the pipeline command "Dev/*" does not change', () => {
    expect(stack.hierarchicalId).toBe('Dev/Flags');
  });

  it('names the stack lab-flags-<namespace>', () => {
    expect(stack.stackName).toBe('lab-flags-my-test');
  });

  it('names the AppConfig application and the deployment strategy after the namespace', () => {
    const template = Template.fromJSON(stack.template);
    template.hasResourceProperties('AWS::AppConfig::Application', { Name: 'lab-flags-my-test' });
    template.hasResourceProperties('AWS::AppConfig::DeploymentStrategy', { Name: 'lab-flags-my-test' });
  });

  it('writes the four parameters and the state parameter to /lab/ns/<namespace>/flags/ and to no other parameter', () => {
    expect(parameterNames(stack)).toEqual([
      '/lab/ns/my-test/flags/application-id',
      '/lab/ns/my-test/flags/environment-id',
      '/lab/ns/my-test/flags/profile-id',
      '/lab/ns/my-test/flags/state/show-discounts',
      '/lab/ns/my-test/flags/version',
    ]);
  });

  it('tags the stack with lab-namespace=<namespace>', () => {
    expect(stack.tags[NAMESPACE_TAG]).toBe('my-test');
  });

  it('uses the version of the context for the output', () => {
    const copy = devStack({ namespace: 'my-test', version: '0.1.0-pr.7' });
    const outputs = (copy.template as { Outputs: { Version: { Value: unknown } } }).Outputs;
    expect(outputs.Version.Value).toBe('0.1.0-pr.7');
  });

  it('exports no output, because an export name is unique in the account', () => {
    expect(JSON.stringify(stack.template)).not.toContain('"Export"');
  });

  it('has no account, no region and no account ID', () => {
    expect(stack.environment.name).toBe('aws://unknown-account/unknown-region');
    expect(JSON.stringify(stack.template)).not.toMatch(ACCOUNT_ID);
  });
});

describe('two namespaces in one account', () => {
  it('use different stack names and parameter names', () => {
    const one = devStack({ namespace: 'one' });
    const two = devStack({ namespace: 'two' });
    expect(one.stackName).not.toBe(two.stackName);
    const names = new Set([...parameterNames(one), ...parameterNames(two)]);
    expect(names.size).toBe(10);
  });
});

describe('an invalid namespace', () => {
  it.each(['Bad', 'a_b', '', 'abc-', 'abcdefghijklmnopqrstu'])('stops the app for %j', (namespace) => {
    expect(() => createApp({ dev: 'true', namespace })).toThrow(/namespace must be 1 to 20 characters/);
  });
});

describe('a namespace without dev=true', () => {
  it('stops the app, so a pipeline stage never gets a namespace', () => {
    expect(() => createApp({ namespace: 'my-test' })).toThrow(/namespace works only with dev=true/);
    expect(() => createApp({ dev: 'false', namespace: 'my-test' })).toThrow(/namespace works only with dev=true/);
  });

  it('stops the app even when the namespace is empty', () => {
    expect(() => createApp({ namespace: '' })).toThrow(/namespace works only with dev=true/);
  });
});

describe('the copy without a namespace (the baseline)', () => {
  it('writes to /lab/flags/ and has no namespace tag', () => {
    const stack = devStack({});
    expect(stack.stackName).toBe('lab-flags');
    expect(parameterNames(stack)).toEqual([
      '/lab/flags/application-id',
      '/lab/flags/environment-id',
      '/lab/flags/profile-id',
      '/lab/flags/state/show-discounts',
      '/lab/flags/version',
    ]);
    expect(stack.tags[NAMESPACE_TAG]).toBeUndefined();
  });

  it('makes the Dev stage the same template as the Test stage, apart from the environment name', () => {
    const dev = JSON.stringify(devStack({}).template).replace('"Name":"dev"', '"Name":"test"');
    const test = createApp().synth().stacksRecursively.find((stack) => stack.hierarchicalId === 'Test/Flags');
    expect(dev).toBe(JSON.stringify(test?.template));
  });
});
