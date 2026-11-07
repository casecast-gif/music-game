import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight, summarizePreflight } from '../public/js/preflight.js';
import { MockSpotifyClient } from '../public/js/mock-spotify.js';

const BROWSER = '__browser__';
const phone = { id: 'phone', name: 'Phone', type: 'Smartphone', is_active: false, is_restricted: false };
const speaker = { id: 'speaker', name: 'Speaker', type: 'Speaker', is_active: true, is_restricted: false };

function client({ profile = { display_name: 'Casey', product: 'premium' }, profileError, devices = [], devicesError } = {}) {
  return {
    getProfile: async () => {
      if (profileError) throw profileError;
      return profile;
    },
    getDevices: async () => {
      if (devicesError) throw devicesError;
      return devices;
    },
  };
}

const byId = (result, id) => result.checks.find((c) => c.id === id);

test('preflight passes with Premium and the saved Connect device', async () => {
  const result = await runPreflight(client({ devices: [phone, speaker] }), { selectedDeviceId: 'phone', browserDeviceId: BROWSER });
  assert.equal(result.ok, true);
  assert.equal(byId(result, 'account').status, 'ok');
  assert.equal(byId(result, 'device').status, 'ok');
  assert.match(byId(result, 'device').detail, /Phone/);
  assert.equal(result.useBrowser, false);
  assert.equal(summarizePreflight(result), 'Spotify check passed.');
});

test('a free account fails; an unknown product does not block', async () => {
  const free = await runPreflight(client({ profile: { id: 'x', product: 'free' }, devices: [speaker] }));
  assert.equal(free.ok, false);
  assert.match(byId(free, 'account').detail, /Premium/);

  const unknown = await runPreflight(client({ profile: { display_name: 'Casey' }, devices: [speaker] }));
  assert.equal(unknown.ok, true);
  assert.equal(byId(unknown, 'account').status, 'ok');
});

test('an expired login fails, offers re-login and skips the device check', async () => {
  let listed = false;
  const c = client({ profileError: Object.assign(new Error('Spotify session expired, please log in again'), { status: 401 }) });
  c.getDevices = async () => { listed = true; return []; };
  const result = await runPreflight(c);
  assert.equal(result.ok, false);
  assert.equal(result.loginProblem, true);
  assert.equal(byId(result, 'device').status, 'skip');
  assert.equal(listed, false);
});

test('a network error on /me fails without claiming a login problem', async () => {
  const result = await runPreflight(client({ profileError: new Error('Spotify request timed out') , devices: [speaker] }));
  assert.equal(result.ok, false);
  assert.equal(result.loginProblem, false);
  assert.match(byId(result, 'account').detail, /timed out/);
});

test('a missing saved device warns and names the device that will be used', async () => {
  const result = await runPreflight(client({ devices: [phone, speaker] }), { selectedDeviceId: 'old-tv' });
  assert.equal(result.ok, true);
  assert.equal(byId(result, 'device').status, 'warn');
  assert.match(byId(result, 'device').detail, /Speaker/); // the active one is preferred
  assert.match(summarizePreflight(result), /^Spotify check passed\. Note:/);
});

test('restricted devices and the browser itself are not counted as Connect devices', async () => {
  const restricted = { ...speaker, id: 'r', is_restricted: true };
  const browserListed = { ...phone, id: 'sdk-1', name: 'Music Game' };
  let started = 0;
  const c = client({ devices: [restricted, browserListed] });
  c.isBrowserDevice = (id) => id === 'sdk-1';
  const result = await runPreflight(c, {
    browserDeviceId: BROWSER,
    startBrowserPlayer: async () => { started += 1; return 'sdk-1'; },
  });
  assert.equal(started, 1);
  assert.equal(result.useBrowser, true);
  assert.equal(result.ok, true);
});

test('no devices: falls back to the browser player, or fails when it cannot start', async () => {
  const fallback = await runPreflight(client(), { browserDeviceId: BROWSER, startBrowserPlayer: async () => 'sdk' });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.useBrowser, true);
  assert.equal(byId(fallback, 'device').status, 'warn');

  const none = await runPreflight(client(), {
    browserDeviceId: BROWSER,
    startBrowserPlayer: async () => { throw new Error('SDK blocked'); },
  });
  assert.equal(none.ok, false);
  assert.equal(none.useBrowser, false);
  assert.match(byId(none, 'device').detail, /SDK blocked/);
  assert.match(byId(none, 'device').detail, /Open Spotify/);
});

test('browser selected: ok when it starts, warn with a fallback, timeout is bounded', async () => {
  const ok = await runPreflight(client({ devices: [phone] }), {
    selectedDeviceId: BROWSER, browserDeviceId: BROWSER, startBrowserPlayer: async () => 'sdk',
  });
  assert.equal(byId(ok, 'device').status, 'ok');
  assert.equal(ok.useBrowser, false);

  const hung = await runPreflight(client({ devices: [phone] }), {
    selectedDeviceId: BROWSER,
    browserDeviceId: BROWSER,
    startBrowserPlayer: () => new Promise(() => {}),
    browserTimeoutMs: 20,
  });
  assert.equal(hung.ok, true);
  assert.equal(byId(hung, 'device').status, 'warn');
  assert.match(byId(hung, 'device').detail, /did not start in time.*Phone/);
});

test('a device-list error fails the device check', async () => {
  const result = await runPreflight(client({ devicesError: new Error('HTTP 503') }));
  assert.equal(result.ok, false);
  assert.match(byId(result, 'device').detail, /503/);
});

test('the mock client passes preflight', async () => {
  const result = await runPreflight(new MockSpotifyClient('id'), { browserDeviceId: BROWSER });
  assert.equal(result.ok, true);
  assert.equal(byId(result, 'device').status, 'ok');
});
