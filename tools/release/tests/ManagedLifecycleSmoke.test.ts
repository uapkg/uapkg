import { expect, it } from 'vite-plus/test';
import { releaseKeySmokeFetch } from '../ManagedLifecycleSmoke.ts';

it('scopes the CI token to the official key API and removes it from the child environment', async () => {
  const env = { UAPKG_RELEASE_KEY_API_TOKEN: 'job-token' };
  const sent: Request[] = [];
  const request = releaseKeySmokeFetch(env, async (input, init) => {
    sent.push(new Request(input, init));
    return new Response('ok');
  });
  expect(env.UAPKG_RELEASE_KEY_API_TOKEN).toBeUndefined();
  const repo = 'https://api.github.com/repos/nodejs/release-keys';
  const sha = 'a'.repeat(40);
  for (const route of [
    '/git/ref/heads/main',
    '/git/trees/' + sha + '?recursive=1',
    '/compare/' + sha + '...' + sha + '?per_page=1',
  ]) {
    await request(repo + route, { redirect: 'follow' });
  }
  expect(
    sent.splice(0).every((r) => r.headers.get('authorization') === 'Bearer job-token' && r.redirect === 'error'),
  ).toBe(true);
  for (const url of [
    'https://nodejs.org/dist/index.json',
    'https://codeload.github.com/nodejs/release-keys/tar.gz/' + sha,
    'https://api.github.com/repos/another/release-keys/git/ref/heads/main',
    repo + '/issues',
    repo + '/git/ref/heads/main?unexpected=1',
  ]) {
    await request(url);
  }
  await request(repo + '/git/ref/heads/main', { method: 'POST' });
  expect(sent.every((r) => !r.headers.has('authorization') && r.redirect === 'error')).toBe(true);
});
