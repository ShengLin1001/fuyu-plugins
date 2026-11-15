// Getting an author's source and its dependencies, treating both as hostile:
// the commit is fetched by id (never a tag), symbolic links are checked out as
// plain files, the git metadata is dropped, and dependencies come only from the
// npm registry, pinned by the lockfile's integrity, with install scripts off.
// Nothing here runs the author's code.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { git } from "./git.mjs";

export const REGISTRY = "https://registry.npmjs.org/";
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const OTHER_LOCKFILES = ["npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const PACKAGE_MANAGER_CONFIG = [".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", ".pnpmfile.mjs"];
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };

/** Where git fetches `repository` from; tests point FUYU_MARKET_GIT_MIRROR at local repositories. */
export const gitUrl = (repository) =>
  `${process.env.FUYU_MARKET_GIT_MIRROR ? repository.replace("https://github.com/", process.env.FUYU_MARKET_GIT_MIRROR) : repository}.git`;

/** Checks out `commit` of `repository` (https://github.com/<owner>/<repo>) into `dir`, without its .git. */
export function fetchCommit(repository, commit, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const run = (...args) => git(args, { cwd: dir, env: GIT_ENV });
  run("init", "-q");
  run("config", "core.symlinks", "false");
  run("config", "core.autocrlf", "false");
  try {
    run("fetch", "-q", "--depth", "1", "--no-tags", gitUrl(repository), commit);
  } catch {
    throw new Error(`commit ${commit} could not be fetched from ${repository} (is the repository public and the commit pushed?).`);
  }
  run("-c", "advice.detachedHead=false", "checkout", "-q", "--detach", "FETCH_HEAD");
  const head = run("rev-parse", "HEAD").trim();
  if (head !== commit) throw new Error(`fetched ${head} instead of ${commit}.`);
  rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  return dir;
}

/** The plugin's folder inside a checkout; `folder` was checked when the submission was. */
export function pluginFolder(checkout, folder = "") {
  const dir = path.resolve(checkout, folder || ".");
  if (dir !== checkout && !dir.startsWith(`${checkout}${path.sep}`)) throw new Error(`"${folder}" is outside the repository.`);
  if (!existsSync(path.join(dir, "package.json")) || !statSync(dir).isDirectory()) throw new Error(`there is no package.json in "${folder || "."}" at that commit.`);
  return dir;
}

/**
 * Whether the plugin's dependencies can be installed the market's way, and how:
 * { install: boolean, problems: [string] }.
 */
export function lockfilePlan(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const declared = DEPENDENCY_FIELDS.some((field) => pkg[field] && Object.keys(pkg[field]).length > 0);
  const other = OTHER_LOCKFILES.filter((file) => existsSync(path.join(dir, file)));
  const lockPath = path.join(dir, "package-lock.json");
  if (other.length > 0) return { install: false, problems: [`${other.join(", ")}: the market installs dependencies with npm from package-lock.json only.`] };
  if (!existsSync(lockPath)) {
    return declared ? { install: false, problems: ["the plugin has dependencies but no package-lock.json; commit the lockfile."] } : { install: false, problems: [] };
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return { install: false, problems: ["package-lock.json is not valid JSON."] };
  }
  if (![2, 3].includes(lock?.lockfileVersion) || typeof lock.packages !== "object" || lock.packages === null) {
    return { install: false, problems: ["package-lock.json must be lockfileVersion 2 or 3 (npm 7 or newer)."] };
  }
  const problems = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "") continue;
    if (entry?.link) problems.push(`package-lock.json: ${key} links a local folder; the market only installs packages from ${REGISTRY}.`);
    else if (entry?.inBundle) continue;
    else if (typeof entry?.resolved !== "string" || !entry.resolved.startsWith(REGISTRY)) {
      problems.push(`package-lock.json: ${key} comes from ${entry?.resolved ?? "an unknown place"}; the market only installs packages from ${REGISTRY}.`);
    } else if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity ?? "")) {
      problems.push(`package-lock.json: ${key} has no sha512 integrity.`);
    }
  }
  const locked = Object.keys(lock.packages).some((key) => key !== "");
  return { install: locked, problems };
}

/** `npm ci` without install scripts, from the public registry only; the author's npm settings are deleted first. */
export function installDependencies(dir) {
  for (const file of PACKAGE_MANAGER_CONFIG) rmSync(path.join(dir, file), { force: true });
  const result = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier", `--registry=${REGISTRY}`], {
    cwd: dir,
    encoding: "utf8",
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_ignore_scripts: "true", npm_config_registry: REGISTRY, npm_config_audit: "false", npm_config_fund: "false" },
  });
  if (result.status !== 0) {
    const tail = `${result.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n");
    throw new Error(`npm ci failed${result.signal ? ` (${result.signal})` : ""}:\n${tail}`);
  }
}

/** Fetches, checks and installs one version; returns the plugin folder. */
export function prepareSource({ repository, commit, path: folder }, checkout) {
  fetchCommit(repository, commit, checkout);
  const dir = pluginFolder(checkout, folder);
  const plan = lockfilePlan(dir);
  if (plan.problems.length > 0) throw new Error(plan.problems.join("\n"));
  if (plan.install) installDependencies(dir);
  else for (const file of PACKAGE_MANAGER_CONFIG) rmSync(path.join(dir, file), { force: true });
  return dir;
}
