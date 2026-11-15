// The v3 market runs the plugin tools of the island repository (TixXin/fuyu) at
// the commit pinned in market/v3/tools.json, never an npm release. They are
// checked out into .tools/fuyu by scripts/v3/fetch-tools.mjs (FUYU_TOOLS moves
// it). @fuyu/plugin-market, -manifest and -review use only Node's own modules
// and load straight from the checkout; @fuyu/plugin-cli needs `--install`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const TOOLS_FILE = "market/v3/tools.json";
export const BUILD_CONFIG_FILE = "market/v3/build-config.json";

export const toolsDir = () => path.resolve(process.env.FUYU_TOOLS ?? path.join(ROOT, ".tools", "fuyu"));

/** { repository, commit, pnpm } from market/v3/tools.json. */
export function toolsPin(root = ROOT) {
  const pin = JSON.parse(readFileSync(path.join(root, TOOLS_FILE), "utf8"));
  if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(pin?.repository ?? "")) throw new Error(`${TOOLS_FILE}: "repository" must be https://github.com/<owner>/<repo>.`);
  if (!/^[0-9a-f]{40}$/.test(pin.commit ?? "")) throw new Error(`${TOOLS_FILE}: "commit" must be a full 40-digit commit id.`);
  if (!/^\d+\.\d+\.\d+$/.test(pin.pnpm ?? "")) throw new Error(`${TOOLS_FILE}: "pnpm" must be an exact version.`);
  return pin;
}

/** The build settings the market passes to `fuyu-plugin` instead of anything in the author's repository. */
export const buildConfig = (root = ROOT) => JSON.parse(readFileSync(path.join(root, BUILD_CONFIG_FILE), "utf8"));

let checked = false;
function checkCheckout() {
  if (checked) return;
  const dir = toolsDir();
  const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
  const { commit } = toolsPin();
  if (head.status !== 0) throw new Error(`The market tools are not checked out in ${dir}: run "npm run tools".`);
  if (head.stdout.trim() !== commit) {
    throw new Error(`The market tools in ${dir} are at ${head.stdout.trim()}, but ${TOOLS_FILE} pins ${commit}: run "npm run tools".`);
  }
  checked = true;
}

async function load(name) {
  checkCheckout();
  const file = path.join(toolsDir(), "packages", name, "src", "index.mjs");
  if (!existsSync(file)) throw new Error(`${file} is missing: run "npm run tools"${name === "plugin-cli" ? " -- --install" : ""}.`);
  return import(pathToFileURL(file).href);
}

export const loadMarket = () => load("plugin-market");
export const loadManifest = () => load("plugin-manifest");
export const loadReview = () => load("plugin-review");
export const loadCli = () => load("plugin-cli");
