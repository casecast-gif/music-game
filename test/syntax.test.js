import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Browser-only modules (app.js etc.) are never imported by unit tests, so a
// syntax error there would otherwise only show up as a dead page.
const dir = fileURLToPath(new URL('../public/js/', import.meta.url));

for (const file of readdirSync(dir).filter((name) => name.endsWith('.js'))) {
  test(`public/js/${file} parses`, () => {
    const result = spawnSync(process.execPath, ['--check', dir + file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
}
