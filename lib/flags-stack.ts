import { CfnOutput, Stack, Tags } from 'aws-cdk-lib';
import {
  CfnApplication,
  CfnConfigurationProfile,
  CfnDeployment,
  CfnDeploymentStrategy,
  CfnEnvironment,
  CfnHostedConfigurationVersion,
} from 'aws-cdk-lib/aws-appconfig';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { buildFeatureFlagContent, buildFlagStates } from './feature-flags.ts';
import type { FlagSet } from './feature-flags.ts';
import { FLAGS } from './flags.ts';
import { NAMESPACE_TAG, namesFor } from './namespace.ts';
import type { StageConfig } from './stages.ts';

export interface FlagsStackProps {
  readonly version: string;
  readonly config: StageConfig;
  // Only the Dev stage sets it (the context value `namespace`). It gives the stack, the AppConfig names and the
  // SSM parameters names of their own. With no namespace the stack has the names of the baseline copy.
  readonly namespace?: string;
  // A test can give another set of flags. The app always uses FLAGS.
  readonly flags?: FlagSet;
}

export class FlagsStack extends Stack {
  constructor(scope: Construct, id: string, props: FlagsStackProps) {
    const names = namesFor(props.namespace);
    // No env here: the stack takes the account and the region of the credentials that deploy it.
    super(scope, id, { stackName: names.stackName });

    if (props.namespace !== undefined) Tags.of(this).add(NAMESPACE_TAG, props.namespace);

    const flags = props.flags ?? FLAGS;
    const content = buildFeatureFlagContent(flags, props.config.flagSet);

    const application = new CfnApplication(this, 'Application', {
      name: names.applicationName,
      description: 'Feature flags of the lab. The pipeline of lab-flags releases them.',
    });
    const environment = new CfnEnvironment(this, 'Environment', {
      applicationId: application.ref,
      name: props.config.environmentName,
    });
    const profile = new CfnConfigurationProfile(this, 'Profile', {
      applicationId: application.ref,
      name: 'flags',
      locationUri: 'hosted',
      type: 'AWS.AppConfig.FeatureFlags',
    });
    // A new text makes a new hosted version, and a new version makes a new deployment. The same text changes nothing.
    // The version of the release is not in the resource, so a release without a flag change makes no new deployment.
    const hosted = new CfnHostedConfigurationVersion(this, 'HostedVersion', {
      applicationId: application.ref,
      configurationProfileId: profile.ref,
      content: JSON.stringify(content),
      contentType: 'application/json',
      description: 'Built from lib/flags.ts',
    });
    const { durationMinutes, growthFactor, bakeMinutes } = props.config.rollout;
    const strategy = new CfnDeploymentStrategy(this, 'Strategy', {
      name: names.strategyName,
      deploymentDurationInMinutes: durationMinutes,
      growthFactor,
      growthType: 'LINEAR',
      finalBakeTimeInMinutes: bakeMinutes,
      replicateTo: 'NONE',
    });
    // CloudFormation waits until the deployment is complete.
    const deployment = new CfnDeployment(this, 'Deployment', {
      applicationId: application.ref,
      environmentId: environment.ref,
      configurationProfileId: profile.ref,
      // The Ref of a hosted version is its version number.
      configurationVersion: hosted.ref,
      deploymentStrategyId: strategy.ref,
    });

    // The services read these parameters at deployment, to find the flags with the AppConfig data API.
    // The IDs are not secret, and they contain no account ID.
    new StringParameter(this, 'ApplicationIdParameter', {
      parameterName: `${names.parameterPrefix}/application-id`,
      description: 'AppConfig application ID of the lab flags',
      stringValue: application.ref,
    });
    new StringParameter(this, 'EnvironmentIdParameter', {
      parameterName: `${names.parameterPrefix}/environment-id`,
      description: 'AppConfig environment ID of the lab flags',
      stringValue: environment.ref,
    });
    new StringParameter(this, 'ProfileIdParameter', {
      parameterName: `${names.parameterPrefix}/profile-id`,
      description: 'AppConfig configuration profile ID of the lab flags',
      stringValue: profile.ref,
    });
    // The pipeline reads this parameter (/lab/flags/version) for the order of the releases and for the release test.
    // It changes after the deployment of the flags is complete, so it shows the new version only when the flags are live.
    const versionParameter = new StringParameter(this, 'VersionParameter', {
      parameterName: `${names.parameterPrefix}/version`,
      description: 'Version of lab-flags that this stack runs',
      stringValue: props.version,
    });
    versionParameter.node.addDependency(deployment);

    // One parameter for each flag holds its declared state in this stage: "on" or "off". The end-to-end suite reads
    // /lab/flags/state/<flag-name> and checks that the product shows this state. Like the version, a state parameter
    // changes only after the deployment is complete, so a suite that runs after the stage deploy sees the live state.
    for (const [flagName, state] of Object.entries(buildFlagStates(flags, props.config.flagSet))) {
      const stateParameter = new StringParameter(this, `StateParameter-${flagName}`, {
        parameterName: `${names.parameterPrefix}/state/${flagName}`,
        description: `Declared state of the flag ${flagName} in this stage (on or off)`,
        stringValue: state,
      });
      stateParameter.node.addDependency(deployment);
    }

    // The pipeline reads Version after a deployment. The deploy job prints the outputs to a public log,
    // so no output may contain the account ID. The IDs of AppConfig do not.
    new CfnOutput(this, 'Version', { value: props.version });
    new CfnOutput(this, 'ApplicationId', { value: application.ref });
    new CfnOutput(this, 'EnvironmentId', { value: environment.ref });
    new CfnOutput(this, 'ProfileId', { value: profile.ref });
  }
}
