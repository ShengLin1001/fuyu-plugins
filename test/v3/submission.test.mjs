import assert from "node:assert/strict";
import test from "node:test";
import { compareSubmissions, fileFor, previousOf, submissionProblems } from "../../scripts/v3/lib/submission.mjs";
import { DEMO, DEMO_FILE, DEMO_REPO, authorKey, market, versionLine } from "./helpers.mjs";

const { privateKey, key } = authorKey();
const other = authorKey();
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const line = (version, commit, signer = privateKey) => versionLine(signer, { version, commit });
const submission = (versions = [line("1.0.0", A)], keys = [key]) => ({ name: DEMO, authorKeys: keys, versions });

test("a signed submission in its own file passes", () => {
  assert.equal(fileFor(DEMO), DEMO_FILE);
  assert.deepEqual(submissionProblems(submission(), DEMO_FILE), []);
  assert.deepEqual(submissionProblems({ ...submission(), path: "plugins/demo" }, DEMO_FILE), []);
});

test("names, files, fields and folders are checked", () => {
  assert.match(submissionProblems(submission(), "plugins/v3/tixxin/other.json").join(), /must be plugins\/v3\/tixxin\/market-ci-demo.json/);
  assert.match(submissionProblems({ ...submission(), name: "market-ci-demo" }, DEMO_FILE).join(), /"name" must be @<scope>\/<name>/);
  assert.match(submissionProblems({ ...submission(), extra: true }, DEMO_FILE).join(), /unknown field "extra"/);
  assert.match(submissionProblems({ ...submission(), path: "../x" }, DEMO_FILE).join(), /"path"/);
  assert.match(submissionProblems({ ...submission(), versions: [] }, DEMO_FILE).join(), /at least one version/);
  const twice = submission([line("1.0.0", A), line("1.0.0", A)]);
  assert.match(submissionProblems(twice, DEMO_FILE).join(), /lists a version twice/);
});

test("the scope must be the repository owner", () => {
  const elsewhere = { ...versionLine(privateKey, { version: "1.0.0", commit: A, repository: "https://github.com/someone/demo" }) };
  assert.match(submissionProblems(submission([elsewhere]), DEMO_FILE).join(), /scope @tixxin must be the repository owner/);
});

test("every version needs the author's signature of its name, version, repository and commit", () => {
  assert.match(submissionProblems(submission([line("1.0.0", A, other.privateKey)]), DEMO_FILE).join(), /"authorSignature" is not a signature/);
  const moved = { ...line("1.0.0", A), commit: B };
  assert.match(submissionProblems(submission([moved]), DEMO_FILE).join(), /"authorSignature" is not a signature/);
  const { authorSignature, ...unsigned } = line("1.0.0", A);
  assert.match(submissionProblems(submission([unsigned]), DEMO_FILE).join(), /"authorSignature" is not a signature/);
  assert.match(submissionProblems(submission([{ ...line("1.0.0", A), commit: "v1.0.0" }]), DEMO_FILE).join(), /40-digit commit/);
  assert.match(submissionProblems(submission(undefined, []), DEMO_FILE).join(), /"authorKeys" must list/);
});

test("urgent needs a reason in both languages", () => {
  const urgent = { ...line("1.0.0", A), urgent: { reason: { "zh-CN": "修复", en: "Fix" } } };
  assert.deepEqual(submissionProblems(submission([urgent]), DEMO_FILE), []);
  assert.match(submissionProblems(submission([{ ...urgent, urgent: { reason: { en: "Fix" } } }]), DEMO_FILE).join(), /"urgent"/);
});

test("official plugins come from TixXin/fuyu and carry no signature or keys", () => {
  const official = { name: "@fuyu/clock", versions: [{ version: "1.0.0", repository: "https://github.com/TixXin/fuyu", commit: A }] };
  assert.deepEqual(submissionProblems(official, "plugins/v3/fuyu/clock.json"), []);
  assert.match(submissionProblems({ ...official, authorKeys: [key] }, "plugins/v3/fuyu/clock.json").join(), /no "authorKeys"/);
  const signed = { ...official, versions: [{ ...official.versions[0], authorSignature: { keyId: key.keyId, signature: "x" } }] };
  assert.match(submissionProblems(signed, "plugins/v3/fuyu/clock.json").join(), /drop "authorSignature"/);
  const fork = { ...official, versions: [{ ...official.versions[0], repository: "https://github.com/someone/fuyu" }] };
  assert.match(submissionProblems(fork, "plugins/v3/fuyu/clock.json").join(), /official plugins come from/);
});

test("a listed version never changes, and only maintainers remove versions or mark them urgent", () => {
  const before = submission([line("1.0.0", A)]);
  const added = compareSubmissions(before, submission([line("1.0.0", A), line("1.1.0", B)]));
  assert.deepEqual(added.errors, []);
  assert.deepEqual(added.added.map((item) => item.version), ["1.1.0"]);

  const changed = compareSubmissions(before, submission([line("1.0.0", C)]), { maintainer: true });
  assert.match(changed.errors.join(), /already listed/);

  assert.match(compareSubmissions(before, submission([line("1.1.0", B)])).errors.join(), /only maintainers may remove a listed version/);
  assert.deepEqual(compareSubmissions(before, submission([line("1.1.0", B)]), { maintainer: true }).errors, []);

  const urgent = submission([{ ...line("1.0.0", A), urgent: { reason: { "zh-CN": "修复", en: "Fix" } } }]);
  assert.match(compareSubmissions(before, urgent).errors.join(), /only maintainers may mark/);
  assert.deepEqual(compareSubmissions(before, urgent, { maintainer: true }).errors, []);

  assert.match(compareSubmissions(before, null).errors.join(), /only maintainers may remove a plugin/);
  assert.match(compareSubmissions(null, before).notes.join(), /First listing/);
});

test("key changes are told apart: endorsed by a listed key, or a new author", () => {
  const before = submission([line("1.0.0", A)]);
  const endorsed = market.endorseKey(DEMO, other.key, privateKey);
  const rotated = compareSubmissions(before, submission([line("1.0.0", A), line("1.1.0", B, other.privateKey)], [key, endorsed]));
  assert.deepEqual(rotated.errors, []);
  assert.match(rotated.notes.join(), /endorsed by/);

  const stranger = compareSubmissions(before, submission([line("1.0.0", A), line("1.1.0", B, other.privateKey)], [key, other.key]));
  assert.match(stranger.notes.join(), /no endorsement/);

  assert.match(compareSubmissions(before, submission([line("1.0.0", A, other.privateKey)], [other.key])).errors.join(), /only maintainers may remove author key/);
});

test("the version a new one is compared with is the highest listed one below it", () => {
  const listed = [{ version: "1.0.0" }, { version: "1.2.0" }, { version: "2.0.0-beta.1" }];
  assert.equal(previousOf("1.3.0", listed).version, "1.2.0");
  assert.equal(previousOf("1.1.0", listed).version, "1.0.0");
  assert.equal(previousOf("2.0.0", listed).version, "2.0.0-beta.1");
  assert.equal(previousOf("0.9.0", listed), null);
  assert.equal(DEMO_REPO, "https://github.com/TixXin/fuyu-plugins");
});
