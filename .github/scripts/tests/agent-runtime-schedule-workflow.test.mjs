import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural checks for .github/workflows/agent-runtime-images.yml.
//
// The `check-for-cli-updates` job must stay detect-only on the weekly
// `schedule` trigger (npm registry lookup + tracking issue, never a docker
// build/push/sign), and publishing a signed image (`build-and-sign`) must
// stay gated to non-schedule events (`push` / `workflow_dispatch`). See
// PR #13996: the schedule previously could reach a signed, published image
// fully unattended from a mutable `npm install -g <pkg>@latest` resolution.
//
// This is a plain-text/regex structural check (no YAML parser dependency in
// this package) mirroring the other `.github/scripts/tests/*.test.mjs`
// checks in this repo.

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(__dirname, '..', '..', 'workflows', 'agent-runtime-images.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

function stripComments(text) {
  // Drop full-line `#` comments (indented or not) so prose like "NOT a
  // docker build" in an explanatory comment can't trip a substring check
  // meant for actual `run:` step content.
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function extractJobBlock(jobName) {
  // Job blocks are top-level YAML keys under `jobs:`, indented two spaces,
  // e.g. "  check-for-cli-updates:". Grab from that line up to (but not
  // including) the next two-space-indented job key, or end of file.
  const jobHeaderRe = new RegExp(`^  ${jobName}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|$(?![\\s\\S]))`, 'm');
  const match = workflow.match(jobHeaderRe);
  assert.ok(match, `expected to find a top-level "${jobName}" job block in the workflow`);
  return match[1];
}

test('schedule trigger is present on a weekly cron', () => {
  assert.match(workflow, /schedule:\s*\n(\s*#.*\n)*\s*-\s*cron:\s*"17 6 \* \* 1"/);
});

test('check-for-cli-updates only runs on the schedule event', () => {
  const block = extractJobBlock('check-for-cli-updates');
  assert.match(block, /if:\s*github\.event_name == 'schedule'/);
});

test('check-for-cli-updates never invokes docker build/bake/push', () => {
  const block = stripComments(extractJobBlock('check-for-cli-updates'));
  assert.doesNotMatch(block, /docker (buildx |)(build|bake)/);
  assert.doesNotMatch(block, /--push/);
  assert.doesNotMatch(block, /cosign sign/);
});

test('check-for-cli-updates only makes a read-only npm registry query, passed via env (not string-interpolated)', () => {
  const block = extractJobBlock('check-for-cli-updates');
  assert.match(block, /registry\.npmjs\.org/);
  assert.match(block, /VERSION_TABLE:\s*\$\{\{\s*steps\.versions\.outputs\.table\s*\}\}/);
  // The table must be read from process.env in the github-script step, never
  // interpolated directly into the script template literal (injection risk).
  assert.match(block, /process\.env\.VERSION_TABLE/);
});

test('build-and-sign is excluded from the schedule event', () => {
  const block = extractJobBlock('build-and-sign');
  assert.match(block, /if:\s*github\.event_name != 'schedule'/);
});

test('build-and-sign is the only job that pushes and cosign-signs images', () => {
  const block = extractJobBlock('build-and-sign');
  assert.match(block, /--push/);
  assert.match(block, /cosign sign --yes/);
});

test('all five harness Dockerfiles are checked, not just claude', () => {
  const block = extractJobBlock('check-for-cli-updates');
  for (const harness of ['claude', 'codex', 'gemini', 'opencode', 'pi']) {
    assert.match(
      block,
      new RegExp(`\\[${harness}\\]=`),
      `expected the PACKAGES map to include harness "${harness}"`
    );
  }
});
