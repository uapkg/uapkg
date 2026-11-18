import { spawnSync } from 'node:child_process';

const REPOSITORY = 'uapkg/uapkg';
const OWNER_ID = 10104630;
const WORKFLOW = '.github/workflows/release-status.yml';

export interface ReleaseStatusRunContext {
  repository: string | undefined;
  ref: string | undefined;
  eventName: string | undefined;
  actorId: string | undefined;
  runId: string | undefined;
  runAttempt: string | undefined;
  sha: string | undefined;
}

/** Check this attempt, including rerun initiators, before any catalog mutation. */
export function assertReleaseStatusAuthorization(value: unknown, context: ReleaseStatusRunContext): void {
  const run = value as {
    id?: unknown;
    run_attempt?: unknown;
    event?: unknown;
    head_branch?: unknown;
    head_sha?: unknown;
    path?: unknown;
    repository?: { full_name?: unknown };
    actor?: { id?: unknown };
    triggering_actor?: { id?: unknown };
  } | null;
  if (
    context.repository !== REPOSITORY ||
    context.ref !== 'refs/heads/main' ||
    context.eventName !== 'workflow_dispatch' ||
    context.actorId !== String(OWNER_ID) ||
    !/^\d+$/.test(context.runId ?? '') ||
    !/^[1-9]\d*$/.test(context.runAttempt ?? '') ||
    !/^[a-f0-9]{40}$/.test(context.sha ?? '') ||
    !run ||
    run.id !== Number(context.runId) ||
    run.run_attempt !== Number(context.runAttempt) ||
    run.event !== 'workflow_dispatch' ||
    run.head_branch !== 'main' ||
    run.head_sha !== context.sha ||
    run.path !== WORKFLOW ||
    run.repository?.full_name !== REPOSITORY ||
    run.actor?.id !== OWNER_ID ||
    run.triggering_actor?.id !== OWNER_ID
  )
    throw new Error('Release status changes require a main-branch dispatch and rerun by GitHub user ID 10104630.');
}

export function authorizeReleaseStatus(environment: NodeJS.ProcessEnv = process.env): void {
  const context = {
    repository: environment.GITHUB_REPOSITORY,
    ref: environment.GITHUB_REF,
    eventName: environment.GITHUB_EVENT_NAME,
    actorId: environment.GITHUB_ACTOR_ID,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    sha: environment.GITHUB_SHA,
  };
  // Validate path components locally before using them in the API URL.
  if (!/^\d+$/.test(context.runId ?? '') || !/^[1-9]\d*$/.test(context.runAttempt ?? ''))
    throw new Error('Expected the current GitHub Actions run and attempt.');
  const response = spawnSync(
    'gh',
    ['api', `repos/${REPOSITORY}/actions/runs/${context.runId}/attempts/${context.runAttempt}`],
    { encoding: 'utf8', windowsHide: true, env: environment },
  );
  if (response.error || response.status !== 0)
    throw new Error(`Could not authorize the current workflow attempt: ${response.error?.message ?? response.stderr}`);
  assertReleaseStatusAuthorization(JSON.parse(response.stdout), context);
}
