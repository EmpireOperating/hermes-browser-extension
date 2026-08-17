import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('current Empire fallback release and update surfaces use the Empire repository identity', async () => {
  const [packageText, readme, sidepanel, watch, reviewEvent, firefoxBuild] = await Promise.all([
    read('package.json'),
    read('README.md'),
    read('extension/sidepanel.js'),
    read('scripts/hermes-review-watch.mjs'),
    read('scripts/hermes-review-github-event.mjs'),
    read('scripts/build-firefox.mjs'),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.version, '0.1.13');
  assert.equal(packageJson.homepage, 'https://github.com/EmpireOperating/hermes-browser-extension#readme');
  assert.equal(packageJson.repository.url, 'https://github.com/EmpireOperating/hermes-browser-extension.git');
  assert.equal(packageJson.bugs.url, 'https://github.com/EmpireOperating/hermes-browser-extension/issues');

  assert.match(readme, /git clone https:\/\/github\.com\/EmpireOperating\/hermes-browser-extension\.git/);
  assert.match(readme, /Empire-controlled Hermes Browser Extension fallback/);
  assert.match(sidepanel, /raw\.githubusercontent\.com\/EmpireOperating\/hermes-browser-extension\/main\/package\.json/);
  assert.match(sidepanel, /api\.github\.com\/repos\/EmpireOperating\/hermes-browser-extension\/commits\/main/);
  assert.match(sidepanel, /const REPO_URL = 'https:\/\/github\.com\/EmpireOperating\/hermes-browser-extension'/);
  assert.match(watch, /const DEFAULT_REPO = 'EmpireOperating\/hermes-browser-extension'/);
  assert.match(reviewEvent, /\(\?!EmpireOperating\\\/hermes-browser-extension/);
  assert.match(firefoxBuild, /id: 'hermes-browser@empireoperating\.github\.io'/);

  for (const activeSurface of [packageText, sidepanel, watch, reviewEvent, firefoxBuild]) {
    assert.doesNotMatch(activeSurface, /abundantbeing\/hermes-browser-extension|abundantbeing\.github\.io/i);
  }
});
