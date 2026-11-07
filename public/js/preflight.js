import { settleWithin } from './async-utils.js';

/**
 * Spotify preflight: checks the things that make a game night fail on the
 * first song (expired login, non-Premium account, no reachable device) while
 * the host is still on the setup screen. Pure apart from the injected client
 * and browser-player starter, so it is unit-testable.
 *
 * Each check is { id, label, status: 'ok' | 'warn' | 'fail' | 'skip', detail }.
 * `ok` is false when any check failed. `useBrowser` asks the caller to switch
 * the device choice to this browser's player (it was started successfully).
 */

export const BROWSER_PLAYER_TIMEOUT_MS = 12_000;

function isLoginError(err) {
  return err?.status === 401 || /log ?in|logged in|session expired|refresh token|invalid_grant/i.test(err?.message ?? '');
}

function errorText(err) {
  return err?.message || String(err);
}

async function checkAccount(client) {
  try {
    const profile = await client.getProfile();
    const who = profile?.display_name || profile?.id || 'Spotify account';
    const product = profile?.product;
    if (product === 'premium') {
      return { id: 'account', label: 'Spotify account', status: 'ok', detail: `Logged in as ${who} (Premium).` };
    }
    if (product) {
      return {
        id: 'account',
        label: 'Spotify account',
        status: 'fail',
        detail: `Logged in as ${who}, but the account is “${product}”. Spotify only lets Premium accounts control playback — log in with a Premium account.`,
      };
    }
    // Development-mode apps may not receive `product`; don't block on unknown.
    return {
      id: 'account',
      label: 'Spotify account',
      status: 'ok',
      detail: `Logged in as ${who}. (Spotify did not say whether it is Premium; playback needs Premium.)`,
    };
  } catch (err) {
    if (isLoginError(err)) {
      return {
        id: 'account',
        label: 'Spotify account',
        status: 'fail',
        loginProblem: true,
        detail: 'The Spotify login has expired. Open Settings → Spotify and log in again.',
      };
    }
    return { id: 'account', label: 'Spotify account', status: 'fail', detail: `Could not reach Spotify: ${errorText(err)}` };
  }
}

function deviceName(device) {
  return `${device.name}${device.type ? ` (${device.type})` : ''}`;
}

async function tryBrowser(startBrowserPlayer, timeoutMs) {
  if (!startBrowserPlayer) return { ok: false, error: new Error('Browser playback is not available.') };
  const outcome = await settleWithin(startBrowserPlayer(), timeoutMs);
  if (outcome.status === 'fulfilled' && outcome.value) return { ok: true };
  if (outcome.status === 'timeout') return { ok: false, error: new Error('The browser player did not start in time.') };
  return { ok: false, error: outcome.reason ?? new Error('The browser player did not start.') };
}

const NO_DEVICE_HELP = 'Open Spotify on a phone, computer or speaker (press play once so it wakes up), then press Check again.';

async function checkDevice(client, { selectedDeviceId, browserDeviceId, startBrowserPlayer, browserTimeoutMs }) {
  const label = 'Playback device';
  let devices;
  try {
    devices = await client.getDevices();
  } catch (err) {
    return { check: { id: 'device', label, status: 'fail', detail: `Could not list Spotify devices: ${errorText(err)}` } };
  }
  const isBrowser = (id) => id === browserDeviceId || Boolean(client.isBrowserDevice?.(id));
  const usable = (devices ?? []).filter((d) => d?.id && !d.is_restricted && !isBrowser(d.id));
  const fallback = usable.find((d) => d.is_active) ?? usable[0];

  if (isBrowser(selectedDeviceId)) {
    const browser = await tryBrowser(startBrowserPlayer, browserTimeoutMs);
    if (browser.ok) return { check: { id: 'device', label, status: 'ok', detail: 'This browser is ready to play.' } };
    if (fallback) {
      return {
        check: {
          id: 'device',
          label,
          status: 'warn',
          detail: `This browser could not start playback (${errorText(browser.error)}). Songs will play on ${deviceName(fallback)} instead.`,
        },
      };
    }
    return {
      check: { id: 'device', label, status: 'fail', detail: `This browser could not start playback (${errorText(browser.error)}). ${NO_DEVICE_HELP}` },
    };
  }

  const selected = usable.find((d) => d.id === selectedDeviceId);
  if (selected) return { check: { id: 'device', label, status: 'ok', detail: `${deviceName(selected)} is ready.` } };
  if (fallback) {
    return {
      check: selectedDeviceId
        ? { id: 'device', label, status: 'warn', detail: `Your last device is not available. Songs will play on ${deviceName(fallback)}.` }
        : { id: 'device', label, status: 'ok', detail: `Songs will play on ${deviceName(fallback)}.` },
    };
  }

  // Nothing open on Spotify Connect: fall back to this browser automatically.
  const browser = await tryBrowser(startBrowserPlayer, browserTimeoutMs);
  if (browser.ok) {
    return {
      useBrowser: true,
      check: { id: 'device', label, status: 'warn', detail: 'No Spotify app is open, so songs will play in this browser.' },
    };
  }
  return {
    check: { id: 'device', label, status: 'fail', detail: `No Spotify device found and this browser could not play (${errorText(browser.error)}). ${NO_DEVICE_HELP}` },
  };
}

export async function runPreflight(client, {
  selectedDeviceId = null,
  browserDeviceId = null,
  startBrowserPlayer = null,
  browserTimeoutMs = BROWSER_PLAYER_TIMEOUT_MS,
} = {}) {
  const account = await checkAccount(client);
  let device;
  if (account.loginProblem) {
    device = { check: { id: 'device', label: 'Playback device', status: 'skip', detail: 'Checked after you log in again.' } };
  } else {
    device = await checkDevice(client, { selectedDeviceId, browserDeviceId, startBrowserPlayer, browserTimeoutMs });
  }
  const checks = [account, device.check];
  return {
    ok: checks.every((c) => c.status !== 'fail'),
    loginProblem: Boolean(account.loginProblem),
    useBrowser: Boolean(device.useBrowser),
    checks,
  };
}

/** One-line summary for the status bar. */
export function summarizePreflight(result) {
  if (!result.ok) return result.checks.filter((c) => c.status === 'fail').map((c) => c.detail).join(' ');
  const warnings = result.checks.filter((c) => c.status === 'warn').map((c) => c.detail);
  return warnings.length ? `Spotify check passed. Note: ${warnings.join(' ')}` : 'Spotify check passed.';
}
