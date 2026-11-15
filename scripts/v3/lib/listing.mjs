// What the market keeps about one built version: the parts of the built manifest
// the island shows before installing, and the files that go to the release.
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const PLATFORMS = ["windows", "macos"];
export const MAX_SCREENSHOTS = 6;

export const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The index's "manifest" summary from a built package.json. */
export function manifestSummary(built, appKey = "fuyu") {
  const app = built[appKey] ?? {};
  const summary = {
    displayName: app.displayName,
    description: app.description,
    license: built.license,
    nodeApis: app.nodeApis ?? [],
    network: app.network ?? [],
    inject: { required: app.inject?.required ?? [], optional: app.inject?.optional ?? [] },
    provides: app.provides ?? [],
    replaces: app.replaces ?? [],
    slots: app.slots ?? [],
    commands: (app.commands ?? []).map(({ id, title, keybinding }) => ({ id, ...(title ? { title } : {}), ...(keybinding ? { keybinding } : {}) })),
  };
  if (app.categories) summary.categories = app.categories;
  if (typeof app.preview === "boolean") summary.preview = app.preview;
  if (app.requires) summary.requires = app.requires;
  return summary;
}

/** The base of the release file names: "@someone/weather" 1.2.0 → "someone-weather-1.2.0". */
export const fileBase = (name, version) => `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}`;

/**
 * Copies the icon and screenshots out of the build output into `out`, named after
 * the version, and returns { icon: { file, sha256 }, screenshots: [{ file, sha256, caption? }] }.
 */
export function extractAssets(builtDir, built, out, base, appKey = "fuyu") {
  const app = built[appKey] ?? {};
  const copy = (source, name) => {
    const from = path.join(builtDir, source);
    if (!statSync(from).isFile()) throw new Error(`${source} is not a file in the built package.`);
    const target = `${base}.${name}${path.extname(source).toLowerCase()}`;
    copyFileSync(from, path.join(out, target));
    return { file: target, sha256: sha256File(from) };
  };
  const icon = copy(app.icon, "icon");
  const screenshots = (app.screenshots ?? []).slice(0, MAX_SCREENSHOTS).map((shot, index) => ({
    ...copy(shot.path, `screenshot-${index + 1}`),
    ...(shot.caption ? { caption: shot.caption } : {}),
  }));
  return { icon, screenshots };
}

/** The platforms a version runs on: the manifest's, or both. */
export const platformsOf = (built, appKey = "fuyu") => {
  const listed = built[appKey]?.platforms;
  return Array.isArray(listed) && listed.length > 0 ? PLATFORMS.filter((name) => listed.includes(name)) : [...PLATFORMS];
};
