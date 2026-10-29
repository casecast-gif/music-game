import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePath, server } from '../server.js';

test('resolvePath blocks path traversal', () => {
  assert.match(resolvePath('/'), /index\.html$/);
  assert.match(resolvePath('/js/app.js?x=1'), /app\.js$/);
  assert.match(resolvePath('/../package.json'), /[\\/]public[\\/]package\.json$/);
  assert.equal(resolvePath('/js/..%2f..%2fpackage.json'), null);
  assert.equal(resolvePath('/%E0%A4%A'), null);
});

test('server serves the host page', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>Music Game<\/title>/);
    assert.match(html, /id="mode-no-steve"[^>]*aria-pressed="true">No Steve<\/button>/);
    assert.match(html, /id="mode-im-steve"[^>]*disabled[^>]*>I'm Steve<\/button>/);
    assert.match(html, /id="open-spotify-player"/);
    const playerPage = await fetch(`http://127.0.0.1:${port}/spotify-player.html`);
    assert.equal(playerPage.status, 200);
    assert.match(await playerPage.text(), /id="spotify-embed"/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope.js`)).status, 404);
  } finally {
    server.close();
  }
});
