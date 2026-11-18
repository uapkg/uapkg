import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { assertReleaseStatusAuthorization, type ReleaseStatusRunContext } from '../releaseStatusAuthorization.ts';

const context: ReleaseStatusRunContext = {
  repository: 'uapkg/uapkg',
  ref: 'refs/heads/main',
  eventName: 'workflow_dispatch',
  actorId: '10104630',
  runId: '12345',
  runAttempt: '2',
  sha: 'a'.repeat(40),
};
const run = {
  id: 12345,
  run_attempt: 2,
  event: 'workflow_dispatch',
  head_branch: 'main',
  head_sha: context.sha,
  path: '.github/workflows/release-status.yml',
  repository: { full_name: 'uapkg/uapkg' },
  actor: { id: 10104630 },
  triggering_actor: { id: 10104630 },
};
describe('release status workflow authorization', () => {
  it('accepts the approved numeric user ID for original dispatches and reruns', () => {
    expect(() => assertReleaseStatusAuthorization(run, context)).not.toThrow();
    expect(() =>
      assertReleaseStatusAuthorization({ ...run, run_attempt: 1 }, { ...context, runAttempt: '1' }),
    ).not.toThrow();
  });
  it.each([
    { actor: { id: 7 } },
    { triggering_actor: { id: 7 } },
    { triggering_actor: undefined },
    { id: 12346 },
    { run_attempt: 1 },
    { event: 'push' },
    { head_branch: 'develop' },
    { head_sha: 'b'.repeat(40) },
    { repository: { full_name: 'other/uapkg' } },
    { path: '.github/workflows/release.yml' },
  ])('rejects unauthorized or mismatched attempt metadata (%j)', (fields) => {
    expect(() => assertReleaseStatusAuthorization({ ...run, ...fields }, context)).toThrow('GitHub user ID');
  });
  it.each([
    { repository: 'other/uapkg' },
    { ref: 'refs/heads/develop' },
    { eventName: 'push' },
    { actorId: '7' },
    { runId: '../12345' },
    { runAttempt: '0' },
    { sha: undefined },
  ])('rejects unauthorized dispatch context (%j)', (fields) => {
    expect(() => assertReleaseStatusAuthorization(run, { ...context, ...fields })).toThrow('GitHub user ID');
  });
  it('authorizes inside the mutation job before checkout and checks the current rerun initiator', () => {
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, '../../../.github/workflows/release-status.yml'),
      'utf8',
    );
    expect(workflow).toContain('actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT');
    expect(workflow).toContain('.actor.id == 10104630 and .triggering_actor.id == 10104630');
    expect(workflow.indexOf('name: Authorize this workflow attempt')).toBeLessThan(
      workflow.indexOf('uses: actions/checkout'),
    );
    expect(workflow).toContain('vp exec node tools/release/releaseStatus.ts');
  });
});
