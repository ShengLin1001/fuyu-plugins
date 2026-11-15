// keys/trusted.v3.json and revoked.v3.json.
//
// The trust root holds two lists that must not share a key: "index" (the key the
// CI signs index.v3.json with) and "revocation" (the maintainer's offline key for
// revoked.v3.json). The island compiles in the same root. The CI never signs
// revoked.v3.json: a maintainer signs it on their own computer and opens a pull
// request, so a leaked CI key cannot disable plugins.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadMarket } from "./tools.mjs";

const market = await loadMarket();

export const TRUST_FILE = "keys/trusted.v3.json";
export const INDEX_FILE = "index.v3.json";
export const REVOKED_FILE = "revoked.v3.json";
export const signatureFile = (file) => `${file}.sig`;

/** Problems with the shape of a trust root (empty when fine). */
export function trustProblems(trust) {
  if (typeof trust !== "object" || trust === null || Array.isArray(trust)) return [`${TRUST_FILE} must be { "index": [...], "revocation": [...] }.`];
  const errors = [];
  const extra = Object.keys(trust).filter((key) => !["index", "revocation"].includes(key));
  if (extra.length > 0) errors.push(`${TRUST_FILE}: unknown field ${extra.map((key) => `"${key}"`).join(", ")}.`);
  for (const role of ["index", "revocation"]) {
    const keys = trust[role];
    if (!Array.isArray(keys) || !keys.every((key) => market.isPublicKeyEntry(key) && Object.keys(key).length === 2)) {
      errors.push(`${TRUST_FILE}: "${role}" must list { keyId, publicKey } entries.`);
    }
  }
  if (errors.length === 0 && market.trustOverlaps(trust)) errors.push(`${TRUST_FILE}: a key may sign the index or the revocations, not both.`);
  return errors;
}

export function parseTrust(text) {
  let trust;
  try {
    trust = JSON.parse(text);
  } catch {
    throw new Error(`${TRUST_FILE} is not valid JSON.`);
  }
  const errors = trustProblems(trust);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return trust;
}

export const readTrust = (root) => parseTrust(readFileSync(path.join(root, TRUST_FILE), "utf8"));

/** The signature file's JSON, or undefined (so the market library reports a bad signature). */
export function parseSignature(text) {
  try {
    return text == null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Opens revoked.v3.json like the island does; null when there is none. */
export function openRevokedText(text, signatureText, trust, { lastSerial = null, now = Date.now() } = {}) {
  if (text == null) return null;
  return market.openRevoked({ text, signature: parseSignature(signatureText), trust, lastSerial, now });
}

/** revoked.v3.json as it stands in `root`: { serial } when it is signed by a revocation key, null when absent. Throws when it is rejected. */
export function currentRevoked(root, trust) {
  const file = path.join(root, REVOKED_FILE);
  if (!existsSync(file)) return null;
  const sig = path.join(root, signatureFile(REVOKED_FILE));
  const opened = openRevokedText(readFileSync(file, "utf8"), existsSync(sig) ? readFileSync(sig, "utf8") : null, trust);
  if (opened.status === "rejected") throw new Error(`${REVOKED_FILE} is rejected (${opened.reason}${describe(opened.problems)}).`);
  return { serial: opened.doc.serial, status: opened.status };
}

const describe = (problems) => (problems?.length ? `: ${problems.map((item) => `${item.path} ${item.message}`).join("; ")}` : "");

/**
 * Problems with a change to revoked.v3.json: it must be signed by a revocation key
 * of the base's trust root, its serial must grow, and entries and withdrawals are
 * only ever added, never changed or dropped.
 */
export function revokedChangeProblems({ before, beforeSignature, after, afterSignature, trust, now = Date.now() }) {
  if (after == null) return before == null ? [] : [`${REVOKED_FILE} cannot be removed.`];
  const previous = before == null ? null : market.openRevoked({ text: before, signature: parseSignature(beforeSignature), trust, now });
  const lastSerial = previous && previous.status !== "rejected" ? previous.doc.serial : null;
  const opened = market.openRevoked({ text: after, signature: parseSignature(afterSignature), trust, lastSerial, now });
  if (opened.status === "rejected") {
    const why = { "bad-signature": "it is not signed by a revocation key in keys/trusted.v3.json", "older-serial": "its serial is lower than the current one" }[opened.reason] ?? opened.reason;
    return [`${REVOKED_FILE} is rejected: ${why}${describe(opened.problems)}.`];
  }
  if (!previous || previous.status === "rejected") return [];
  const errors = [];
  if (opened.doc.serial === previous.doc.serial && after !== before) errors.push(`${REVOKED_FILE}: a changed list needs a higher serial.`);
  const entries = new Map(opened.doc.entries.map((entry) => [entry.id, entry]));
  for (const entry of previous.doc.entries) {
    if (!entries.has(entry.id)) errors.push(`${REVOKED_FILE}: entry ${entry.id} was dropped; entries are never removed (withdraw it instead).`);
    else if (JSON.stringify(entries.get(entry.id)) !== JSON.stringify(entry)) errors.push(`${REVOKED_FILE}: entry ${entry.id} changed; an id keeps its first content (use a new id).`);
  }
  const withdrawn = new Set(opened.doc.withdrawn.map((item) => item.id));
  for (const item of previous.doc.withdrawn) if (!withdrawn.has(item.id)) errors.push(`${REVOKED_FILE}: the withdrawal of ${item.id} was dropped.`);
  return errors;
}
