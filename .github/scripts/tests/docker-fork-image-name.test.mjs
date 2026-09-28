import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/docker.yml", import.meta.url), "utf8");

test("fork image and cache references use a lowercase GHCR repository", () => {
  assert.doesNotMatch(workflow, /ghcr\.io\/\$\{\{\s*github\.repository\s*\}\}/);
  assert.match(workflow, /cache-from: type=registry,ref=ghcr\.io\/bluephi09\/paperclip:buildcache-/);
  assert.match(workflow, /cache-to: type=registry,ref=ghcr\.io\/bluephi09\/paperclip:buildcache-/);
  assert.match(workflow, /outputs: type=image,name=ghcr\.io\/bluephi09\/paperclip,/);
});
