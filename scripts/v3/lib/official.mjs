// Official plugins (@fuyu/*) carry no author signature: what vouches for a
// version is that its commit is in the history of TixXin/fuyu's main, which only
// takes reviewed pull requests that pass CI and cannot be force-pushed.
//
// The commit must be checked against main itself: GitHub serves a commit of any
// fork through the parent repository's address, so "it can be fetched from
// TixXin/fuyu" proves nothing.
import { api } from "../../lib/github.mjs";

const REQUIRED_RULES = ["pull_request", "non_fast_forward"];

/** { ok: true } when `commit` is in the history of the protected `branch` of `repository`, else { ok: false, reason }. */
export async function onProtectedMain(commit, repository, { branch = "main", request = api } = {}) {
  const repo = repository.replace(/^https:\/\/github\.com\//, "");
  const rules = await request(`/repos/${repo}/rules/branches/${branch}`);
  if (rules.status !== 200 || !Array.isArray(rules.body)) return { ok: false, reason: `the rules of ${repo}'s ${branch} could not be read (${rules.status}).` };
  const types = new Set(rules.body.map((rule) => rule?.type));
  const missing = REQUIRED_RULES.filter((type) => !types.has(type));
  if (missing.length > 0) return { ok: false, reason: `${repo}'s ${branch} is not protected (no ${missing.join(", ")} rule).` };
  const compared = await request(`/repos/${repo}/compare/${commit}...${branch}`);
  if (compared.status !== 200) return { ok: false, reason: `${commit} is not a commit of ${repo} (${compared.status}).` };
  if (!["ahead", "identical"].includes(compared.body?.status)) {
    return { ok: false, reason: `${commit} is not in the history of ${repo}'s ${branch} (${compared.body?.status ?? "unknown"}).` };
  }
  return { ok: true };
}
