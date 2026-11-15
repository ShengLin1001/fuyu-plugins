// plugins/v3/<scope>/<name>.json: an author's submission to the v3 market.
//
// {
//   "name": "@someone/weather",
//   "path": "plugins/weather",                       optional, the plugin's folder in the repository
//   "authorKeys": [{ "keyId", "publicKey" }],        what `fuyu-plugin keygen` prints; none for @fuyu/*
//   "versions": [
//     { "version", "repository", "commit", "authorSignature" },   one line per version, from what `fuyu-plugin sign` prints
//     { ..., "urgent": { "reason": { "zh-CN", "en" } } }          maintainers only
//   ]
// }
//
// The market builds each version from its commit; a listed version never changes.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadManifest, loadMarket } from "./tools.mjs";

const market = await loadMarket();
const manifest = await loadManifest();

export const V3_DIR = "plugins/v3";
export const FILE_PATTERN = /^plugins\/v3\/[^/]+\/[^/]+\.json$/;
export const OFFICIAL_SCOPE = market.DEFAULT_MARKET.officialScope;
export const OFFICIAL_REPOSITORY = market.DEFAULT_MARKET.officialRepository;
export const MAX_AUTHOR_KEYS = 5;

const PLUGIN_KEYS = new Set(["name", "path", "authorKeys", "versions"]);
const VERSION_KEYS = new Set(["version", "repository", "commit", "authorSignature", "urgent"]);
const KEY_KEYS = new Set(["keyId", "publicKey", "endorsedBy"]);
const REPOSITORY = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;
const FOLDER = /^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const COMMIT = /^[0-9a-f]{40}$/;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isLocalized = (value) => isObject(value) && ["zh-CN", "en"].every((locale) => typeof value[locale] === "string" && value[locale].trim() !== "");

export const parseName = (name) => market.parseName(name);
export const isOfficialName = (name) => parseName(name)?.scope === OFFICIAL_SCOPE;
export const ownerOf = (repository) => REPOSITORY.exec(repository ?? "")?.[1] ?? null;
export const compareVersions = (left, right) => market.compareVersions(left, right);

export function fileFor(name) {
  const parsed = parseName(name);
  return parsed ? `${V3_DIR}/${parsed.scope}/${parsed.name}.json` : null;
}

/** The fields an author signs for one version. */
export const commitFields = (name, line) => ({ name, version: line.version, repository: line.repository, commit: line.commit });

function keyProblems(name, keys) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_AUTHOR_KEYS) {
    return [`"authorKeys" must list 1-${MAX_AUTHOR_KEYS} keys as "fuyu-plugin keygen" prints them.`];
  }
  const errors = [];
  for (const key of keys) {
    const extra = Object.keys(key ?? {}).filter((field) => !KEY_KEYS.has(field));
    if (!market.isPublicKeyEntry(key) || extra.length > 0) {
      errors.push(`"authorKeys" has an entry that is not { keyId, publicKey } as "fuyu-plugin keygen" prints it.`);
    } else if (key.endorsedBy !== undefined && market.verifyEndorsement(name, key, keys) === null) {
      errors.push(`"authorKeys": the endorsedBy of ${key.keyId} is not a valid signature for ${name} by another listed key.`);
    }
  }
  if (new Set(keys.map((key) => key?.keyId)).size !== keys.length) errors.push(`"authorKeys" lists a key twice.`);
  return errors;
}

function versionProblems(name, line, keys, official) {
  if (!isObject(line)) return ["every entry of \"versions\" must be an object."];
  const label = typeof line.version === "string" ? `version ${line.version}` : "a version";
  const errors = [];
  for (const field of Object.keys(line)) if (!VERSION_KEYS.has(field)) errors.push(`${label}: unknown field "${field}".`);
  if (!market.isValidVersion(line.version)) errors.push(`${label}: "version" must be a semver version like 1.2.0.`);
  if (!REPOSITORY.test(line.repository ?? "")) {
    errors.push(`${label}: "repository" must be https://github.com/<owner>/<repo>.`);
  } else if (official) {
    if (line.repository !== OFFICIAL_REPOSITORY) errors.push(`${label}: official plugins come from ${OFFICIAL_REPOSITORY}.`);
  } else {
    const problem = manifest.checkPluginName(name, line.repository);
    if (problem) errors.push(`${label}: ${problem.message}.`);
  }
  if (!COMMIT.test(line.commit ?? "")) errors.push(`${label}: "commit" must be the full 40-digit commit id in lowercase (not a tag).`);
  if (line.urgent !== undefined && !(isObject(line.urgent) && Object.keys(line.urgent).join() === "reason" && isLocalized(line.urgent.reason))) {
    errors.push(`${label}: "urgent" must be { "reason": { "zh-CN", "en" } }.`);
  }
  if (official) {
    if (line.authorSignature !== undefined) errors.push(`${label}: official plugins are not signed by a key; drop "authorSignature".`);
  } else if (errors.length === 0 && market.verifyCommit(commitFields(name, line), line.authorSignature, Array.isArray(keys) ? keys : []) === null) {
    errors.push(`${label}: "authorSignature" is not a signature of this name, version, repository and commit by one of "authorKeys" ("fuyu-plugin sign" makes it).`);
  }
  return errors;
}

/** Problems with one submission on its own: shape, names, signatures. `file` is its path in the repository. */
export function submissionProblems(submission, file) {
  if (!isObject(submission)) return ["must be a JSON object."];
  const errors = [];
  for (const field of Object.keys(submission)) if (!PLUGIN_KEYS.has(field)) errors.push(`unknown field "${field}".`);
  const { name, path: folder, authorKeys, versions } = submission;
  const parsed = parseName(name);
  if (!parsed) return [...errors, `"name" must be @<scope>/<name> in lowercase, the scope being the GitHub owner of the repository.`];
  if (file !== undefined && file !== fileFor(name)) errors.push(`the file must be ${fileFor(name)}.`);
  const official = parsed.scope === OFFICIAL_SCOPE;
  if (folder !== undefined && (typeof folder !== "string" || folder.length > 200 || !FOLDER.test(folder))) {
    errors.push(`"path" must be a folder inside the repository, like plugins/weather.`);
  }
  if (official) {
    if (authorKeys !== undefined && !(Array.isArray(authorKeys) && authorKeys.length === 0)) errors.push(`official plugins have no "authorKeys".`);
  } else {
    errors.push(...keyProblems(name, authorKeys));
  }
  if (!Array.isArray(versions) || versions.length === 0) return [...errors, `"versions" must list at least one version.`];
  for (const line of versions) errors.push(...versionProblems(name, line, authorKeys, official));
  const seen = versions.map((line) => line?.version);
  if (new Set(seen).size !== seen.length) errors.push(`"versions" lists a version twice.`);
  return errors;
}

const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** The highest version in `listed` below `version` (each { version, ... }), or null. */
export function previousOf(version, listed) {
  return (
    listed
      .filter((line) => compareVersions(line.version, version) < 0)
      .sort((left, right) => compareVersions(right.version, left.version))[0] ?? null
  );
}

/**
 * What a change to one submission does, checked against who made it: listed
 * versions never change, and only maintainers remove versions or keys, or mark a
 * version urgent. `before` is null for a new plugin, `after` null when it is removed.
 * Returns { errors, notes, added: [version lines new in `after`] }.
 */
export function compareSubmissions(before, after, { maintainer = false } = {}) {
  const errors = [];
  const notes = [];
  if (!after) {
    if (maintainer) notes.push("The plugin is removed from the market; installed copies keep working (revoke them in revoked.v3.json if needed).");
    else errors.push("only maintainers may remove a plugin (open an issue).");
    return { errors, notes, added: [] };
  }
  const name = after.name;
  const old = new Map((before?.versions ?? []).map((line) => [line.version, line]));
  const added = [];
  for (const line of after.versions ?? []) {
    const listed = old.get(line.version);
    if (!listed) {
      added.push(line);
      if (line.urgent && !maintainer) errors.push(`version ${line.version}: only maintainers may mark a version urgent.`);
      continue;
    }
    old.delete(line.version);
    if (["repository", "commit", "authorSignature"].some((field) => !same(listed[field], line[field]))) {
      errors.push(`version ${line.version} is already listed; its repository, commit and signature cannot change. Publish a new version instead.`);
    }
    if (!same(listed.urgent, line.urgent)) {
      if (maintainer) notes.push(`Version ${line.version}: "urgent" changed.`);
      else errors.push(`version ${line.version}: only maintainers may mark a version urgent.`);
    }
  }
  for (const version of old.keys()) {
    if (maintainer) notes.push(`Version ${version} is no longer listed (installed copies keep working; revoke it in revoked.v3.json if it is harmful).`);
    else errors.push(`version ${version}: only maintainers may remove a listed version.`);
  }

  if (before) {
    const oldKeys = before.authorKeys ?? [];
    const newKeys = after.authorKeys ?? [];
    for (const key of oldKeys.filter((item) => !newKeys.some((next) => next.keyId === item.keyId))) {
      if (maintainer) notes.push(`Author key ${key.keyId} is removed.`);
      else errors.push(`only maintainers may remove author key ${key.keyId}.`);
    }
    for (const key of newKeys.filter((item) => !oldKeys.some((prev) => prev.keyId === item.keyId))) {
      const endorsedBy = market.verifyEndorsement(name, key, [...oldKeys, ...newKeys]);
      if (endorsedBy && chainsTo(name, key, oldKeys, newKeys)) {
        notes.push(`New author key ${key.keyId}, endorsed by ${endorsedBy}: islands ask once before taking the next update and do not update it by themselves.`);
      } else {
        notes.push(`⚠️ New author key ${key.keyId} has no endorsement from a listed key: islands treat the plugin as having a new author and ask twice. Check the author's identity before approving.`);
      }
    }
    const lastBefore = latestOf(before.versions ?? []);
    for (const line of added) {
      if (lastBefore && line.repository !== lastBefore.repository) {
        notes.push(`⚠️ Version ${line.version} comes from ${line.repository}, not ${lastBefore.repository}: islands treat a moved plugin as a new author and ask twice.`);
      }
    }
    if ((before.path ?? "") !== (after.path ?? "")) notes.push(`The plugin's folder changes from "${before.path ?? ""}" to "${after.path ?? ""}".`);
  } else {
    notes.push("First listing: read the whole source.");
  }
  return { errors, notes, added };
}

/** Whether a chain of endorsements leads from a key in `oldKeys` to `key`. */
function chainsTo(name, key, oldKeys, newKeys, seen = new Set()) {
  if (oldKeys.some((item) => item.keyId === key.keyId)) return true;
  if (seen.has(key.keyId) || !key.endorsedBy) return false;
  seen.add(key.keyId);
  const parent = [...oldKeys, ...newKeys].find((item) => item.keyId === key.endorsedBy.keyId);
  return Boolean(parent) && market.verifyEndorsement(name, key, [parent]) !== null && chainsTo(name, parent, oldKeys, newKeys, seen);
}

/** Every submission file under plugins/v3 of `root`, as { file, text }, sorted. */
export function submissionFiles(root) {
  const dir = path.join(root, V3_DIR);
  if (!existsSync(dir)) return [];
  const files = [];
  for (const scope of readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    for (const entry of readdirSync(path.join(dir, scope.name), { withFileTypes: true })) {
      const file = `${V3_DIR}/${scope.name}/${entry.name}`;
      if (entry.isFile() && FILE_PATTERN.test(file)) files.push({ file, text: readFileSync(path.join(root, file), "utf8") });
    }
  }
  return files.sort((left, right) => left.file.localeCompare(right.file));
}

/** The submissions of `root` that pass submissionProblems, as parsed objects. */
export function validSubmissions(root) {
  const valid = [];
  for (const { file, text } of submissionFiles(root)) {
    let submission;
    try {
      submission = JSON.parse(text);
    } catch {
      continue;
    }
    if (submissionProblems(submission, file).length === 0) valid.push(submission);
  }
  return valid;
}

/** The highest version among `lines`, or null. */
export const latestOf = (lines) => [...lines].sort((left, right) => compareVersions(right.version, left.version))[0] ?? null;
