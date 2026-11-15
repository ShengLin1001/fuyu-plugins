import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMarket } from "../../scripts/v3/lib/tools.mjs";

export const market = await loadMarket();
export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const DEMO = "@tixxin/market-ci-demo";
export const DEMO_REPO = "https://github.com/TixXin/fuyu-plugins";
export const DEMO_FILE = "plugins/v3/tixxin/market-ci-demo.json";

export function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

export const tempDir = (prefix = "fuyu-v3-test-") => mkdtempSync(path.join(os.tmpdir(), prefix));

/** A fresh git repository with a committer, so tests do not depend on the user's git settings. */
export function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  run("git", ["init", "-q", "-b", "main"], dir);
  run("git", ["config", "user.name", "test"], dir);
  run("git", ["config", "user.email", "test@example.com"], dir);
  run("git", ["config", "commit.gpgsign", "false"], dir);
  return dir;
}

export function commitAll(dir, message, date) {
  run("git", ["add", "-A"], dir);
  const env = date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {};
  const result = spawnSync("git", ["commit", "-q", "-m", message], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(result.stderr);
  return run("git", ["rev-parse", "HEAD"], dir);
}

/**
 * A local repository standing in for https://github.com/TixXin/fuyu-plugins.
 * `commit(fixture)` replaces its files with a fixture folder and returns the commit id.
 */
export function makeMirror() {
  const root = tempDir("fuyu-v3-mirror-");
  const repo = initRepo(path.join(root, "TixXin", "fuyu-plugins.git"));
  run("git", ["config", "uploadpack.allowAnySHA1InWant", "true"], repo);
  return {
    root,
    url: `file://${root}/`,
    commit(fixture) {
      for (const entry of readdirSync(repo)) if (entry !== ".git") rmSync(path.join(repo, entry), { recursive: true, force: true });
      cpSync(path.join(FIXTURES, fixture), repo, { recursive: true });
      return commitAll(repo, fixture);
    },
  };
}

export function authorKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, key: market.publicKeyOf(privateKey) };
}

/** One "versions" line, signed like `fuyu-plugin sign` does. */
export function versionLine(privateKey, { name = DEMO, version, repository = DEMO_REPO, commit }) {
  return { version, repository, commit, authorSignature: market.signCommit({ name, version, repository, commit }, privateKey) };
}
