import { describe, expect, it } from 'vitest';
import type { CloudAssembly, CloudFormationStackArtifact } from 'aws-cdk-lib/cx-api';
import { createApp } from '../lib/app.ts';
import { DEV_STAGE, STAGES } from '../lib/stages.ts';

// Twelve digits that are not a part of a longer number or of a hex hash.
const ACCOUNT_ID = /(?<![0-9a-f])[0-9]{12}(?![0-9a-f])/i;

interface TemplateShape {
  readonly Resources: Record<string, { readonly Type: string }>;
  readonly Outputs: { readonly Version: { readonly Value: unknown } };
}

function templateOf(stack: CloudFormationStackArtifact): TemplateShape {
  return stack.template as TemplateShape;
}

function stageNames(assembly: CloudAssembly): string[] {
  // The cloud assembly lists the stages in alphabetical order.
  return assembly.nestedAssemblies.map((nested) => nested.displayName).sort();
}

function stackIds(assembly: CloudAssembly): string[] {
  return assembly.stacksRecursively.map((stack) => stack.hierarchicalId).sort();
}

function versions(assembly: CloudAssembly): unknown[] {
  return assembly.stacksRecursively.map((stack) => templateOf(stack).Outputs.Version.Value);
}

describe('the app with no context', () => {
  const assembly = createApp().synth();

  it('has the three stages Test, Staging and Production, and no other stage', () => {
    expect(stageNames(assembly)).toEqual(['Production', 'Staging', 'Test']);
  });

  it('has one stack in each stage', () => {
    expect(stackIds(assembly)).toEqual(['Production/Flags', 'Staging/Flags', 'Test/Flags']);
  });

  it('names the stack lab-flags in each stage, because the diff job of the pipeline uses the repository name', () => {
    for (const stack of assembly.stacksRecursively) {
      expect(stack.stackName).toBe('lab-flags');
    }
  });

  it('has no account and no region in any stack', () => {
    for (const stack of assembly.stacksRecursively) {
      expect(stack.environment.name).toBe('aws://unknown-account/unknown-region');
    }
  });

  it('needs no lookup in an AWS account at synth', () => {
    expect(assembly.manifest.missing ?? []).toEqual([]);
  });

  it('has no account ID in any template', () => {
    for (const stack of assembly.stacksRecursively) {
      expect(JSON.stringify(stack.template)).not.toMatch(ACCOUNT_ID);
    }
  });

  it('has only AppConfig resources and SSM parameters', () => {
    for (const stack of assembly.stacksRecursively) {
      for (const resource of Object.values(templateOf(stack).Resources)) {
        expect(resource.Type).toMatch(/^AWS::(AppConfig::|SSM::Parameter$)/);
      }
    }
  });

  it('uses the version 0.0.0-dev', () => {
    expect(versions(assembly)).toEqual(['0.0.0-dev', '0.0.0-dev', '0.0.0-dev']);
  });
});

describe('the app with a version in the context', () => {
  it('uses that version in each stage', () => {
    expect(versions(createApp({ version: '1.4.0' }).synth())).toEqual(['1.4.0', '1.4.0', '1.4.0']);
  });

  it('accepts the version of a pre-release', () => {
    expect(versions(createApp({ version: '0.1.0-pr.12' }).synth())).toEqual(['0.1.0-pr.12', '0.1.0-pr.12', '0.1.0-pr.12']);
  });

  it.each(['', 'v1.4.0', '1.4', 'latest', '1.4.0 ', 140])('rejects the version %j', (version) => {
    expect(() => createApp({ version })).toThrow(/version must look like 1\.2\.3/);
  });
});

describe('the app with dev=true in the context', () => {
  const assembly = createApp({ dev: 'true' }).synth();

  it('has only the stage Dev', () => {
    expect(stageNames(assembly)).toEqual(['Dev']);
    expect(stackIds(assembly)).toEqual(['Dev/Flags']);
  });

  it('accepts the boolean true, as cdk.json gives it', () => {
    expect(stageNames(createApp({ dev: true }).synth())).toEqual(['Dev']);
  });

  it('has no account, no region and no account ID', () => {
    for (const stack of assembly.stacksRecursively) {
      expect(stack.environment.name).toBe('aws://unknown-account/unknown-region');
      expect(JSON.stringify(stack.template)).not.toMatch(ACCOUNT_ID);
    }
  });

  it('accepts dev=false and makes the three stages', () => {
    expect(stageNames(createApp({ dev: 'false' }).synth())).toEqual(['Production', 'Staging', 'Test']);
  });

  it('rejects a value of dev that is not true or false', () => {
    expect(() => createApp({ dev: 'yes' })).toThrow(/dev must be true or false/);
  });
});

describe('the stage config', () => {
  it('rolls out Test, Staging and Dev at once, and Production in steps', () => {
    expect(STAGES.Test.rollout).toEqual({ durationMinutes: 0, growthFactor: 100, bakeMinutes: 0 });
    expect(STAGES.Staging.rollout).toEqual({ durationMinutes: 0, growthFactor: 100, bakeMinutes: 0 });
    expect(DEV_STAGE.rollout).toEqual({ durationMinutes: 0, growthFactor: 100, bakeMinutes: 0 });
    expect(STAGES.Production.rollout).toEqual({ durationMinutes: 2, growthFactor: 50, bakeMinutes: 1 });
  });

  it('gives each stage the flag values of the same name, and Dev the values of Test', () => {
    expect(STAGES.Test.flagSet).toBe('test');
    expect(STAGES.Staging.flagSet).toBe('staging');
    expect(STAGES.Production.flagSet).toBe('production');
    expect(DEV_STAGE.flagSet).toBe('test');
  });
});
