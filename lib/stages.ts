import type { FlagStageName } from './feature-flags.ts';

// How AppConfig moves a new flag version to its targets. A linear strategy gives growthFactor percent of the targets in each step.
export interface Rollout {
  readonly durationMinutes: number;
  readonly growthFactor: number;
  readonly bakeMinutes: number;
}

// The settings that can differ between stages. All other things are the same in each stage.
export interface StageConfig {
  // The name of the AppConfig environment.
  readonly environmentName: string;
  // The column of the flag file that this stage uses.
  readonly flagSet: FlagStageName;
  readonly rollout: Rollout;
}

// Immediate: all targets at once, no bake time. The pipeline does not wait in Test and Staging.
const IMMEDIATE: Rollout = { durationMinutes: 0, growthFactor: 100, bakeMinutes: 0 };

// The pipeline deploys these stages. Each stage goes to its own AWS account.
// Production is gradual: 50 percent after the start, all after 1 minute, then 1 minute of bake time.
// The release takes about 3 minutes. The job deploy-production has a limit of 40 minutes.
export const STAGES = {
  Test: { environmentName: 'test', flagSet: 'test', rollout: IMMEDIATE },
  Staging: { environmentName: 'staging', flagSet: 'staging', rollout: IMMEDIATE },
  Production: { environmentName: 'production', flagSet: 'production', rollout: { durationMinutes: 2, growthFactor: 50, bakeMinutes: 1 } },
} as const satisfies Record<string, StageConfig>;

// A developer deploys this stage from a laptop to a personal account. The pipeline does not use it.
export const DEV_STAGE: StageConfig = { environmentName: 'dev', flagSet: 'test', rollout: IMMEDIATE };
