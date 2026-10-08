import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { findContentProblems } from '../lib/feature-flags.ts';
import type { FlagSet } from '../lib/feature-flags.ts';
import { FlagsStack } from '../lib/flags-stack.ts';
import { FLAGS } from '../lib/flags.ts';
import { STAGES } from '../lib/stages.ts';

// Twelve digits that are not a part of a longer number or of a hex hash.
const ACCOUNT_ID = /(?<![0-9a-f])[0-9]{12}(?![0-9a-f])/i;

type StageName = keyof typeof STAGES;

function templateFor(stage: StageName, flags?: FlagSet, version = '1.2.3'): Template {
  const stack = new FlagsStack(new App(), 'Flags', { version, config: STAGES[stage], flags });
  return Template.fromStack(stack);
}

const TEMPLATES: Record<StageName, Template> = {
  Test: templateFor('Test'),
  Staging: templateFor('Staging'),
  Production: templateFor('Production'),
};

const STAGE_NAMES = Object.keys(STAGES) as StageName[];

describe.each(STAGE_NAMES)('the stack of the stage %s', (stage) => {
  const template = TEMPLATES[stage];

  it('has the six AppConfig resources, one of each type, and nothing else but the parameters', () => {
    template.resourceCountIs('AWS::AppConfig::Application', 1);
    template.resourceCountIs('AWS::AppConfig::Environment', 1);
    template.resourceCountIs('AWS::AppConfig::ConfigurationProfile', 1);
    template.resourceCountIs('AWS::AppConfig::HostedConfigurationVersion', 1);
    template.resourceCountIs('AWS::AppConfig::DeploymentStrategy', 1);
    template.resourceCountIs('AWS::AppConfig::Deployment', 1);
    const types = Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type);
    expect(types.filter((type) => !type.startsWith('AWS::AppConfig::') && type !== 'AWS::SSM::Parameter')).toEqual([]);
  });

  it('names the AppConfig application lab-flags and the environment after the stage', () => {
    template.hasResourceProperties('AWS::AppConfig::Application', { Name: 'lab-flags' });
    template.hasResourceProperties('AWS::AppConfig::Environment', { Name: STAGES[stage].environmentName });
  });

  it('uses a hosted feature-flag profile', () => {
    template.hasResourceProperties('AWS::AppConfig::ConfigurationProfile', {
      LocationUri: 'hosted',
      Type: 'AWS.AppConfig.FeatureFlags',
    });
  });

  it('hosts content that the content validator accepts, with the flag file values of this stage', () => {
    const [hosted] = Object.values(template.findResources('AWS::AppConfig::HostedConfigurationVersion')) as {
      Properties: { Content: string; ContentType: string };
    }[];
    expect(hosted?.Properties.ContentType).toBe('application/json');
    const content: unknown = JSON.parse(hosted?.Properties.Content ?? '');
    expect(findContentProblems(content)).toEqual([]);
    const values = (content as { values: Record<string, { enabled: boolean }> }).values;
    expect(Object.keys(values)).toEqual(Object.keys(FLAGS));
    for (const [name, flag] of Object.entries(FLAGS)) {
      expect(values[name]?.enabled, name).toBe(flag.values[STAGES[stage].flagSet]);
    }
  });

  it('keeps the flag show-discounts off', () => {
    const [hosted] = Object.values(template.findResources('AWS::AppConfig::HostedConfigurationVersion')) as {
      Properties: { Content: string };
    }[];
    const content = JSON.parse(hosted?.Properties.Content ?? '') as { values: Record<string, { enabled: boolean }> };
    expect(content.values['show-discounts']?.enabled).toBe(false);
  });

  it('deploys the hosted version with the strategy of the stage', () => {
    template.hasResourceProperties('AWS::AppConfig::Deployment', {
      ApplicationId: { Ref: Match.stringLikeRegexp('^Application') },
      EnvironmentId: { Ref: Match.stringLikeRegexp('^Environment') },
      ConfigurationProfileId: { Ref: Match.stringLikeRegexp('^Profile') },
      ConfigurationVersion: { Ref: Match.stringLikeRegexp('^HostedVersion') },
      DeploymentStrategyId: { Ref: Match.stringLikeRegexp('^Strategy') },
    });
  });

  it('has the four SSM parameters of /lab/flags, one state parameter for each flag, and no other parameter', () => {
    template.resourceCountIs('AWS::SSM::Parameter', 4 + Object.keys(FLAGS).length);
    const names = Object.values(template.findResources('AWS::SSM::Parameter')).map(
      (resource) => (resource.Properties as { Name: string }).Name,
    );
    expect(names.sort()).toEqual([
      '/lab/flags/application-id',
      '/lab/flags/environment-id',
      '/lab/flags/profile-id',
      '/lab/flags/state/show-discounts',
      '/lab/flags/version',
    ]);
  });

  it('writes the declared state of each flag for this stage to /lab/flags/state/<flag-name>', () => {
    for (const [name, flag] of Object.entries(FLAGS)) {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: `/lab/flags/state/${name}`,
        Type: 'String',
        Value: flag.values[STAGES[stage].flagSet] ? 'on' : 'off',
      });
    }
  });

  it('keeps the state of show-discounts off', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/lab/flags/state/show-discounts', Value: 'off' });
  });

  it('writes the state only after the deployment is complete, like the version', () => {
    template.hasResource('AWS::SSM::Parameter', {
      Properties: { Name: '/lab/flags/state/show-discounts' },
      DependsOn: [Match.stringLikeRegexp('^Deployment')],
    });
  });

  it('writes the version to /lab/flags/version only after the deployment is complete', () => {
    template.hasResource('AWS::SSM::Parameter', {
      Properties: { Name: '/lab/flags/version', Value: '1.2.3' },
      DependsOn: [Match.stringLikeRegexp('^Deployment')],
    });
  });

  it('writes the three IDs as references, so the services read the real IDs', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/flags/application-id',
      Value: { Ref: Match.stringLikeRegexp('^Application') },
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/flags/environment-id',
      Value: { Ref: Match.stringLikeRegexp('^Environment') },
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/flags/profile-id',
      Value: { Ref: Match.stringLikeRegexp('^Profile') },
    });
  });

  it('has the output Version with the version of the release, and the three ID outputs', () => {
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(outputs['Version']?.Value).toBe('1.2.3');
    expect(Object.keys(outputs).sort()).toEqual(['ApplicationId', 'EnvironmentId', 'ProfileId', 'Version']);
  });

  it('has no account ID and no export', () => {
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toMatch(ACCOUNT_ID);
    expect(json).not.toContain('"Export"');
  });
});

describe('the deployment strategy of each stage', () => {
  it('is immediate in Test and Staging', () => {
    for (const stage of ['Test', 'Staging'] as const) {
      TEMPLATES[stage].hasResourceProperties('AWS::AppConfig::DeploymentStrategy', {
        Name: 'lab-flags',
        DeploymentDurationInMinutes: 0,
        GrowthFactor: 100,
        GrowthType: 'LINEAR',
        FinalBakeTimeInMinutes: 0,
        ReplicateTo: 'NONE',
      });
    }
  });

  it('is linear in Production: 50 percent each step for 2 minutes, then 1 minute of bake time', () => {
    TEMPLATES.Production.hasResourceProperties('AWS::AppConfig::DeploymentStrategy', {
      Name: 'lab-flags',
      DeploymentDurationInMinutes: 2,
      GrowthFactor: 50,
      GrowthType: 'LINEAR',
      FinalBakeTimeInMinutes: 1,
      ReplicateTo: 'NONE',
    });
  });
});

describe('the stages together', () => {
  it('differ only in the environment name, the strategy and the flag values of the stage', () => {
    // Test must exercise the resources that Production runs.
    const normalised = (stage: StageName): string =>
      JSON.stringify(TEMPLATES[stage].toJSON())
        .replace(/"Name":"(test|staging|production)"/g, '"Name":"stage"')
        .replace(/"DeploymentDurationInMinutes":[0-9]+/g, '"DeploymentDurationInMinutes":0')
        .replace(/"GrowthFactor":[0-9]+/g, '"GrowthFactor":0')
        .replace(/"FinalBakeTimeInMinutes":[0-9]+/g, '"FinalBakeTimeInMinutes":0');
    expect(normalised('Staging')).toBe(normalised('Test'));
    expect(normalised('Production')).toBe(normalised('Test'));
  });
});

describe('a change of the flags', () => {
  const CHANGED: FlagSet = {
    'show-discounts': { ...FLAGS['show-discounts'], values: { test: true, staging: false, production: false } },
  };

  it('changes the hosted content, so CloudFormation makes a new hosted version and a new deployment', () => {
    const before = JSON.stringify(templateFor('Test').findResources('AWS::AppConfig::HostedConfigurationVersion'));
    const after = JSON.stringify(templateFor('Test', CHANGED).findResources('AWS::AppConfig::HostedConfigurationVersion'));
    expect(after).not.toBe(before);
  });

  it('changes the content of one stage only, when the flag file changes the value of that stage', () => {
    const content = (template: Template): string =>
      JSON.stringify(template.findResources('AWS::AppConfig::HostedConfigurationVersion'));
    expect(content(templateFor('Staging', CHANGED))).toBe(content(templateFor('Staging')));
    expect(content(templateFor('Production', CHANGED))).toBe(content(templateFor('Production')));
  });

  it('does not change the hosted content when only the version of the release changes', () => {
    const content = (version: string): string =>
      JSON.stringify(templateFor('Production', undefined, version).findResources('AWS::AppConfig::HostedConfigurationVersion'));
    expect(content('1.2.4')).toBe(content('1.2.3'));
  });

  it('changes the state parameter of the stage that changes, and of no other stage', () => {
    const state = (template: Template): string =>
      (
        Object.values(template.findResources('AWS::SSM::Parameter')).find(
          (resource) => (resource.Properties as { Name: string }).Name === '/lab/flags/state/show-discounts',
        )?.Properties as { Value: string }
      ).Value;
    expect(state(templateFor('Test', CHANGED))).toBe('on');
    expect(state(templateFor('Staging', CHANGED))).toBe('off');
    expect(state(templateFor('Production', CHANGED))).toBe('off');
  });

  it('writes one state parameter for each flag of another flag set', () => {
    const TWO: FlagSet = {
      ...FLAGS,
      'second-flag': { ...FLAGS['show-discounts'], values: { test: true, staging: true, production: false } },
    };
    const names = (stage: StageName): Record<string, string> =>
      Object.fromEntries(
        Object.values(templateFor(stage, TWO).findResources('AWS::SSM::Parameter'))
          .map((resource) => resource.Properties as { Name: string; Value: string })
          .filter((properties) => properties.Name.startsWith('/lab/flags/state/'))
          .map((properties) => [properties.Name, properties.Value]),
      );
    expect(names('Test')).toEqual({ '/lab/flags/state/show-discounts': 'off', '/lab/flags/state/second-flag': 'on' });
    expect(names('Staging')).toEqual({ '/lab/flags/state/show-discounts': 'off', '/lab/flags/state/second-flag': 'on' });
    expect(names('Production')).toEqual({ '/lab/flags/state/show-discounts': 'off', '/lab/flags/state/second-flag': 'off' });
  });
});

