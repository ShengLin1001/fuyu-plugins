// Checks out the market tools (TixXin/fuyu at the commit in market/v3/tools.json)
// into .tools/fuyu, or FUYU_TOOLS.
//
//   node scripts/v3/fetch-tools.mjs            plugin-market, -manifest and -review (no install)
//   node scripts/v3/fetch-tools.mjs --install  everything @fuyu/plugin-cli needs, installed from
//                                              the island's lockfile without install scripts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolsDir, toolsPin } from "./lib/tools.mjs";

const SOURCE_ONLY = ["/packages/plugin-market/", "/packages/plugin-manifest/", "/packages/plugin-review/"];
const WITH_INSTALL = ["/packages/", "/vendor/", "/package.json", "/pnpm-workspace.yaml", "/pnpm-lock.yaml", "/.npmrc"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal}).`);
}

function headOf(dir) {
  const result = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function fetchTools({ install = false, dir = toolsDir(), pin = toolsPin() } = {}) {
  const git = (...args) => run("git", ["-C", dir, ...args]);
  if (headOf(dir) !== pin.commit) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    git("init", "-q");
    git("remote", "add", "origin", `${pin.repository}.git`);
    git("sparse-checkout", "set", "--no-cone", ...(install ? WITH_INSTALL : SOURCE_ONLY));
    git("fetch", "-q", "--depth", "1", "--filter=blob:none", "--no-tags", "origin", pin.commit);
    git("-c", "advice.detachedHead=false", "checkout", "-q", "--detach", "FETCH_HEAD");
  } else if (install) {
    git("sparse-checkout", "set", "--no-cone", ...WITH_INSTALL);
  }
  if (headOf(dir) !== pin.commit) throw new Error(`${dir} is not at ${pin.commit} after fetching.`);
  if (install && !existsSync(path.join(dir, "packages", "plugin-cli", "node_modules", "esbuild"))) {
    run("npx", ["--yes", `pnpm@${pin.pnpm}`, "install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@fuyu/plugin-cli..."], {
      cwd: dir,
      env: { ...process.env, CI: "true" },
    });
  }
  return dir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const install = process.argv.includes("--install");
  const dir = fetchTools({ install });
  console.log(`Market tools at ${toolsPin().commit} in ${dir}${install ? " (installed)" : ""}.`);
}
