import { spawnSync } from "node:child_process";

export function git(args, { cwd, allowFailure = false, env } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env });
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** [{ status, file }] changed between `base` and HEAD (renames as a delete and an add). */
export function changedFiles(base, cwd) {
  return git(["diff", "--name-status", "--no-renames", `${base}...HEAD`], { cwd })
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, file] = line.split("\t");
      return { status, file };
    });
}

/** The text of `file` at `rev`, or null when it is not there. */
export const fileAt = (rev, file, cwd) => git(["show", `${rev}:${file}`], { cwd, allowFailure: true });

/**
 * When `text` first appeared in `file` on the first-parent history of `rev`: the
 * committer time of the merge (or squash) that brought it to the branch, which is
 * when a maintainer approved it. Null when the history does not show it.
 */
export function firstAddedAt(text, file, { rev = "HEAD", cwd } = {}) {
  const out = git(["log", "--first-parent", "--reverse", "--format=%cI", "-S", text, rev, "--", file], { cwd, allowFailure: true });
  const first = out?.split("\n").find(Boolean);
  return first ? new Date(first).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}
