# lab-flags

This repository holds the feature flags of the lab. The flags are code. You change them in a pull request, and the shared pipeline releases them.

The repository has no web endpoint and no Lambda function. It has one AWS CDK app that makes an AppConfig application, the flag values for each stage and four SSM parameters.

## Why a flag change uses the same pipeline as code

A flag changes what users see, as code does. A wrong flag value can break Production as a wrong line of code can.

So a flag change gets the same protection as code:

- A pull request shows the change, and a person reviews it.
- The tests check every flag before the merge.
- The `cdk diff` comment shows what the change does to the stack.
- The release goes to Test, then Staging, then Production.
- The smoke tests of the four services run after each deployment.
- Git keeps the history. To undo a change, you revert the pull request.

Nobody edits a flag in the AWS console. The next release would replace the edit.

## How it works

The file `lib/flags.ts` is the one source of truth. Each flag has a description, an owner, a `removeBy` date and a value for each stage (`test`, `staging`, `production`).

At synth, `lib/feature-flags.ts` turns the flag file into the AppConfig feature-flag format. One stack per stage holds these resources:

| Resource | Purpose |
| --- | --- |
| Application `lab-flags` | The container of the flags. |
| Environment | One per stage: `test`, `staging` or `production`. |
| Configuration profile `flags` | A hosted profile of type `AWS.AppConfig.FeatureFlags`. |
| Hosted configuration version | The flag values of this stage, as text. |
| Deployment strategy | How AppConfig moves a new version to the clients. |
| Deployment | Starts the strategy for the new hosted version. |

A new flag text makes a new hosted version. A new hosted version makes a new deployment. The same text changes nothing, so a release without a flag change deploys no flags.

Test and Staging deploy all at once. Production deploys in steps: 50 percent of the clients first, 100 percent after 2 minutes, then 1 minute of bake time.

The stack writes four SSM parameters. A service reads the first three to find the flags with the AppConfig data API. The pipeline reads the fourth.

| Parameter | Value |
| --- | --- |
| `/lab/flags/application-id` | The AppConfig application ID. |
| `/lab/flags/environment-id` | The AppConfig environment ID of the stage. |
| `/lab/flags/profile-id` | The configuration profile ID. |
| `/lab/flags/version` | The version of lab-flags that runs in the stage. |

The version parameter depends on the deployment. It shows the new version only after the flags are live. The stack also has the output `Version`, which the deploy job reads.

The IDs are not secret. No template contains an account ID, and a test checks it.

## Add a flag

1. Open `lib/flags.ts`.
2. Add an entry. The key starts with a lower-case letter and has at most 64 characters (letters, digits, `-` and `_`).
3. Write a short description, set the owner, set a `removeBy` date and set a value for each stage.
4. Start the new flag OFF in `production`.
5. Run `npm test`. The tests check the fields and the AppConfig format.
6. Open a pull request with a title that starts with `feat:`.

## Change a flag

1. Change the value for one stage in `lib/flags.ts`. Change `production` last, in its own pull request.
2. Run `npm test`.
3. Open a pull request. Use `feat:` for a new flag and `fix:` for a value change.
4. Read the `cdk diff` comment. It must show only the hosted version, the deployment and the version parameter.

To turn a flag on, change its value in `test` first. Release it, check the result, and then change `staging` and `production`.

## Remove a flag

1. Delete the entry from `lib/flags.ts`. Remove the code in the services that reads the flag first.
2. Run `npm test`.
3. Open a pull request. The next release deploys the smaller flag file.

## What `removeBy` is for

A flag is a temporary switch. A flag that stays for years becomes a hidden branch in the code, and nobody knows what it does.

The `removeBy` date is the day by which the owner removes the flag. A test reads the real date. On the day after `removeBy`, the test fails and names the flag and the owner.

When the test fails, do one of two things:

- Remove the flag.
- Move the `removeBy` date and give the reason in the pull request.

AppConfig has no field for the owner or the date. They stay in the repository and never reach AWS.

## Release

A merge to `main` starts a release. The version comes from the pull request title: `feat:` raises the minor number and other prefixes raise the patch number.

The pipeline deploys Test, runs the smoke tests, deploys Staging, runs the smoke tests, waits for the approval of the Production gate, and then deploys Production. This repository has no HTTP endpoint, so the pipeline reads its version from `/lab/flags/version`.

`pipeline.json` names the service `flags`. The field `requires` is empty, because the stack needs no other service.

## Develop

```sh
npm ci
npm test        # the flag checks and the stack tests
npm run lint
npm run typecheck
npx cdk synth -c version=1.2.3
```

The version context value must look like `1.2.3`. With no value, the version is `0.0.0-dev`.

## Namespaces

You can deploy a private copy of the stack to a personal account. Use the `Dev` stage and a namespace:

```sh
npx cdk deploy "Dev/*" -c dev=true -c namespace=my-test
npx cdk destroy "Dev/*" -c dev=true -c namespace=my-test
```

The namespace has 1 to 20 characters: a letter first, then letters a-z, digits and `-`, and no `-` at the end. The copy gets the stack name `lab-flags-<namespace>` and writes its parameters to `/lab/ns/<namespace>/flags/`. A tag `lab-namespace` marks its resources.

The `namespace` value works only with `dev=true`. The pipeline stages have fixed names and never read it. The `Dev` stage uses the Test flag values and deploys all at once.
