import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { postReport } from "../../scripts/v3/comment.mjs";
import { revokedChangeProblems, trustProblems } from "../../scripts/v3/lib/documents.mjs";
import { lockfilePlan } from "../../scripts/v3/lib/source.mjs";
import { authorKey, market, tempDir } from "./helpers.mjs";

const revocation = authorKey();
const index = authorKey();
const trust = { index: [index.key], revocation: [revocation.key] };
const now = Date.parse("2026-11-15T12:00:00Z");
const reason = { "zh-CN": "原因", en: "Reason" };

function revoked(serial, entries, withdrawn = [], signer = revocation.privateKey) {
  const text = `${JSON.stringify({ format: 3, serial, generatedAt: "2026-11-15T00:00:00Z", expires: "2026-12-15T00:00:00Z", entries, withdrawn }, null, 2)}\n`;
  return { text, signature: JSON.stringify(market.signText(text, signer)) };
}
const entry = (id, level = "disable") => ({ id, name: "@someone/weather", version: "1.2.0", level, reason });

test("the trust root holds two separate lists of keys", () => {
  assert.deepEqual(trustProblems(trust), []);
  assert.deepEqual(trustProblems({ index: [], revocation: [] }), []);
  assert.match(trustProblems({ index: [index.key], revocation: [index.key] }).join(), /not both/);
  assert.match(trustProblems({ index: [{ keyId: "x", publicKey: "y" }], revocation: [] }).join(), /"index" must list/);
  assert.match(trustProblems({ index: [], revocation: [], extra: [] }).join(), /unknown field/);
});

test("revoked.v3.json must be signed by a revocation key, grow its serial and only add entries", () => {
  const first = revoked(1, [entry("a")]);
  assert.deepEqual(revokedChangeProblems({ before: null, after: first.text, afterSignature: first.signature, trust, now }), []);

  const byIndexKey = revoked(1, [entry("a")], [], index.privateKey);
  assert.match(revokedChangeProblems({ before: null, after: byIndexKey.text, afterSignature: byIndexKey.signature, trust, now }).join(), /not signed by a revocation key/);

  const grown = revoked(2, [entry("a"), entry("b", "warn")], [{ id: "a", reason }]);
  assert.deepEqual(revokedChangeProblems({ before: first.text, beforeSignature: first.signature, after: grown.text, afterSignature: grown.signature, trust, now }), []);

  const dropped = revoked(3, [entry("b", "warn")]);
  const problems = revokedChangeProblems({ before: grown.text, beforeSignature: grown.signature, after: dropped.text, afterSignature: dropped.signature, trust, now }).join("\n");
  assert.match(problems, /entry a was dropped/);
  assert.match(problems, /withdrawal of a was dropped/);

  const softened = revoked(3, [entry("a", "warn")]);
  assert.match(revokedChangeProblems({ before: first.text, beforeSignature: first.signature, after: softened.text, afterSignature: softened.signature, trust, now }).join(), /entry a changed/);

  const older = revoked(0, [entry("a")]);
  assert.match(revokedChangeProblems({ before: first.text, beforeSignature: first.signature, after: older.text, afterSignature: older.signature, trust, now }).join(), /serial is lower/);
  assert.match(revokedChangeProblems({ before: first.text, beforeSignature: first.signature, after: null, trust, now }).join(), /cannot be removed/);
});

test("dependencies are installed only from the npm registry, by a lockfile npm ci understands", () => {
  const plugin = (pkg, files = {}) => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@x/y", version: "1.0.0", ...pkg }));
    for (const [file, value] of Object.entries(files)) writeFileSync(path.join(dir, file), typeof value === "string" ? value : JSON.stringify(value));
    return dir;
  };
  const lock = (packages) => ({ lockfileVersion: 3, packages: { "": {}, ...packages } });
  const registry = { resolved: "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz", integrity: "sha512-AAAA" };
  assert.deepEqual(lockfilePlan(plugin({})), { install: false, problems: [] });
  assert.match(lockfilePlan(plugin({ dependencies: { ms: "^2.1.3" } })).problems.join(), /no package-lock\.json/);
  assert.deepEqual(lockfilePlan(plugin({ dependencies: { ms: "^2.1.3" } }, { "package-lock.json": lock({ "node_modules/ms": registry }) })), { install: true, problems: [] });
  const git = lock({ "node_modules/ms": { resolved: "git+ssh://git@github.com/x/ms.git#abc", integrity: "sha512-AAAA" } });
  assert.match(lockfilePlan(plugin({ dependencies: { ms: "x/ms" } }, { "package-lock.json": git })).problems.join(), /only installs packages from/);
  const link = lock({ "node_modules/local": { link: true, resolved: "../local" } });
  assert.match(lockfilePlan(plugin({}, { "package-lock.json": link })).problems.join(), /links a local folder/);
  assert.match(lockfilePlan(plugin({ dependencies: { ms: "1" } }, { "pnpm-lock.yaml": "lockfileVersion: 9" })).problems.join(), /package-lock\.json only/);
  assert.match(lockfilePlan(plugin({}, { "package-lock.json": { lockfileVersion: 1, dependencies: {} } })).problems.join(), /lockfileVersion 2 or 3/);
  const noIntegrity = lock({ "node_modules/ms": { resolved: registry.resolved } });
  assert.match(lockfilePlan(plugin({}, { "package-lock.json": noIntegrity })).problems.join(), /no sha512 integrity/);
});

function fakeGitHub({ head = "h".repeat(40), files = ["plugins/v3/x/y.json"], comments = [] } = {}) {
  const calls = [];
  const request = async (url, { method = "GET", body } = {}) => {
    calls.push({ method, url, body });
    if (url === "/repos/o/r/pulls/7") return { status: 200, body: { state: "open", head: { sha: head } } };
    if (url.startsWith("/repos/o/r/pulls/7/files")) return { status: 200, body: files.map((filename) => ({ filename })) };
    if (url.startsWith("/repos/o/r/issues/7/comments") && method === "GET") return { status: 200, body: comments };
    return { status: method === "POST" ? 201 : 200, body: { html_url: "https://example.com/c" } };
  };
  return { request, calls };
}

test("the report is posted once and then updated, only on the pull request whose head was checked", async () => {
  const body = "<!-- fuyu-market-v3-report -->\n## report\n";
  const fresh = fakeGitHub();
  assert.equal((await postReport({ repo: "o/r", number: 7, headSha: "h".repeat(40), body, request: fresh.request })).updated, false);
  assert.equal(fresh.calls.at(-1).method, "POST");
  assert.doesNotMatch(fresh.calls.at(-1).body.body, /⚠️/);

  const existing = fakeGitHub({ comments: [{ id: 1, user: { login: "someone" }, body }, { id: 2, user: { login: "github-actions[bot]" }, body }] });
  await postReport({ repo: "o/r", number: 7, headSha: null, body, request: existing.request });
  assert.equal(existing.calls.at(-1).url, "/repos/o/r/issues/comments/2");

  const moved = fakeGitHub({ head: "g".repeat(40) });
  assert.match((await postReport({ repo: "o/r", number: 7, headSha: "h".repeat(40), body, request: moved.request })).skipped, /not the checked/);

  const scripts = fakeGitHub({ files: ["plugins/v3/x/y.json", "scripts/v3/build.mjs"] });
  await postReport({ repo: "o/r", number: 7, headSha: null, body, request: scripts.request });
  assert.match(scripts.calls.at(-1).body.body, /scripts\/v3\/build\.mjs/);
  await assert.rejects(postReport({ repo: "o/r", number: 7, body: "no marker", request: fresh.request }), /marker/);
});
