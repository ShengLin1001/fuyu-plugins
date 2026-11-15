import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { onProtectedMain } from "../../scripts/v3/lib/official.mjs";
import { planPublish, planPullRequest } from "../../scripts/v3/plan.mjs";
import { DEMO, DEMO_FILE, authorKey, commitAll, initRepo, market, run, tempDir, versionLine } from "./helpers.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const { privateKey, key } = authorKey();
const submission = (versions) => ({ name: DEMO, authorKeys: [key], versions });

function write(root, file, value) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/** A market checkout whose main holds `before`; returns { root, base } with HEAD on a branch. */
function market_(before = {}) {
  const root = initRepo(tempDir());
  write(root, "README.md", "market\n");
  for (const [file, value] of Object.entries(before)) write(root, file, value);
  const base = commitAll(root, "base");
  run("git", ["switch", "-q", "-c", "pr"], root);
  return { root, base };
}

const noApi = async (url) => {
  throw new Error(`unexpected request ${url}`);
};

test("a new version in a pull request is planned against the last listed one", async () => {
  const { root, base } = market_({ [DEMO_FILE]: submission([versionLine(privateKey, { version: "1.0.0", commit: A })]) });
  write(root, DEMO_FILE, submission([versionLine(privateKey, { version: "1.0.0", commit: A }), versionLine(privateKey, { version: "1.1.0", commit: B })]));
  commitAll(root, "1.1.0");
  const plan = await planPullRequest(root, { base, author: "TixXin", association: "OWNER", request: noApi });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.builds.length, 1);
  assert.equal(plan.builds[0].version, "1.1.0");
  assert.equal(plan.builds[0].previous.commit, A);
});

test("versions added together are each compared with the one before, as islands would update", async () => {
  const { root, base } = market_();
  write(root, DEMO_FILE, submission([versionLine(privateKey, { version: "1.0.0", commit: A }), versionLine(privateKey, { version: "1.1.0", commit: B })]));
  commitAll(root, "two versions");
  const plan = await planPullRequest(root, { base, author: "TixXin", association: "OWNER", request: noApi });
  assert.deepEqual(
    plan.builds.map((build) => [build.version, build.previous?.version ?? null]),
    [
      ["1.0.0", null],
      ["1.1.0", "1.0.0"],
    ],
  );
});

test("someone who does not own the repository cannot submit it, nor put a file elsewhere", async () => {
  const { root, base } = market_();
  write(root, DEMO_FILE, submission([versionLine(privateKey, { version: "1.0.0", commit: A })]));
  write(root, "plugins/v3/stray.json", "{}");
  commitAll(root, "submit");
  const request = async (url) => (url === "/orgs/TixXin/public_members/mallory" ? { status: 404, body: null } : noApi(url));
  const plan = await planPullRequest(root, { base, author: "mallory", association: "NONE", request });
  assert.match(plan.errors.join("\n"), /@mallory must own https:\/\/github\.com\/TixXin\/fuyu-plugins/);
  assert.match(plan.errors.join("\n"), /plugins\/v3\/stray\.json: submissions go in/);
  assert.equal(plan.builds.length, 0);
});

test("an official version must be on TixXin/fuyu's protected main, and only maintainers submit one", async () => {
  const official = { name: "@fuyu/clock", versions: [{ version: "1.0.0", repository: "https://github.com/TixXin/fuyu", commit: C }] };
  const { root, base } = market_();
  write(root, "plugins/v3/fuyu/clock.json", official);
  commitAll(root, "official");
  const rules = { status: 200, body: [{ type: "pull_request" }, { type: "non_fast_forward" }] };
  const onMain = async (url) => (url.includes("/rules/") ? rules : { status: 200, body: { status: "ahead" } });
  const offMain = async (url) => (url.includes("/rules/") ? rules : { status: 200, body: { status: "diverged" } });
  assert.deepEqual((await planPullRequest(root, { base, author: "TixXin", association: "OWNER", request: onMain })).errors, []);
  assert.match((await planPullRequest(root, { base, author: "TixXin", association: "OWNER", request: offMain })).errors.join(), /not in the history/);
  assert.match((await planPullRequest(root, { base, author: "someone", association: "NONE", request: onMain })).errors.join(), /only maintainers may submit official/);
});

test("the protected-main check needs both the rules and the history", async () => {
  const ok = { status: 200, body: { status: "identical" } };
  const unprotected = async (url) => (url.includes("/rules/") ? { status: 200, body: [{ type: "deletion" }] } : ok);
  assert.match((await onProtectedMain(A, "https://github.com/TixXin/fuyu", { request: unprotected })).reason, /not protected/);
  const missing = async (url) => (url.includes("/rules/") ? { status: 200, body: [{ type: "pull_request" }, { type: "non_fast_forward" }] } : { status: 404, body: null });
  assert.match((await onProtectedMain(A, "https://github.com/TixXin/fuyu", { request: missing })).reason, /not a commit/);
});

test("publishing plans what the index lacks, with the time the version reached main as its review time", async () => {
  const root = initRepo(tempDir());
  write(root, DEMO_FILE, submission([versionLine(privateKey, { version: "1.0.0", commit: A })]));
  commitAll(root, "1.0.0", "2026-11-10T08:00:00Z");
  write(root, DEMO_FILE, submission([versionLine(privateKey, { version: "1.0.0", commit: A }), versionLine(privateKey, { version: "1.1.0", commit: B })]));
  commitAll(root, "1.1.0", "2026-11-12T09:30:00Z");
  const plan = await planPublish(root, { request: noApi, now: Date.parse("2026-11-15T00:00:00Z") });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(
    plan.builds.map((build) => [build.version, build.reviewedAt, build.previous?.version ?? null]),
    [
      ["1.0.0", "2026-11-10T08:00:00Z", null],
      ["1.1.0", "2026-11-12T09:30:00Z", null],
    ],
  );
  assert.equal(market.FORMAT, 3);
});
