import { Stage } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { FlagsStack } from './flags-stack.ts';
import type { FlagsStackProps } from './flags-stack.ts';

// One deployable copy of the service. `cdk deploy "<id>/*"` deploys all the stacks of one stage.
export class FlagsStage extends Stage {
  constructor(scope: Construct, id: string, props: FlagsStackProps) {
    super(scope, id);
    new FlagsStack(this, 'Flags', props);
  }
}
