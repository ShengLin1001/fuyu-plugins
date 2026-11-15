// Signs index.v3.json. The signing job gets only the assembled file: it installs
// nothing and loads only @fuyu/plugin-market (Node's own modules) from the pinned
// tools, so the key never meets plugin code or npm packages.
//
//   node scripts/v3/sign-index.mjs --dir <dir>               with FUYU_INDEX_V3_SIGNING_KEY (PEM), checked against keys/trusted.v3.json
//   node scripts/v3/sign-index.mjs --dir <dir> --ephemeral   with a throwaway key, for rehearsals
//
// Writes <dir>/index.v3.json.sig after opening the signed index the way the island does.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { INDEX_FILE, readTrust, signatureFile } from "./lib/documents.mjs";
import { ephemeralTrust, signIndex, signatureText } from "./lib/market-index.mjs";
import { ROOT } from "./lib/tools.mjs";

export const KEY_ENV = "FUYU_INDEX_V3_SIGNING_KEY";

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { dir: { type: "string" }, ephemeral: { type: "boolean" } } });
  if (!values.dir) {
    console.error("Usage: node scripts/v3/sign-index.mjs --dir <dir> [--ephemeral]");
    process.exit(2);
  }
  const file = path.join(values.dir, INDEX_FILE);
  const text = readFileSync(file, "utf8");
  const current = path.join(ROOT, INDEX_FILE);
  const lastSerial = existsSync(current) ? JSON.parse(readFileSync(current, "utf8")).serial : null;
  let privateKey;
  let trust;
  if (values.ephemeral) {
    ({ privateKey, trust } = ephemeralTrust());
  } else {
    const pem = process.env[KEY_ENV];
    if (!pem?.trim()) {
      console.error(`${KEY_ENV} is not set.`);
      process.exit(1);
    }
    privateKey = pem;
    trust = readTrust(ROOT);
    if (trust.index.length === 0) {
      console.error("keys/trusted.v3.json lists no index key yet: add the public key of the index signing key first.");
      process.exit(1);
    }
  }
  try {
    const { signature, keyId, doc } = signIndex(text, privateKey, trust, { lastSerial });
    writeFileSync(path.join(values.dir, signatureFile(INDEX_FILE)), signatureText(signature));
    const summary = `Signed ${INDEX_FILE} with ${values.ephemeral ? "the throwaway key" : "key"} ${keyId}: serial ${doc.serial}, expires ${doc.expires}, ${doc.plugins.length} plugin(s); it opens as the island opens it.\n`;
    console.log(summary.trim());
    if (values.ephemeral) console.log(`Throwaway public key (trusted by no island): ${JSON.stringify(trust.index[0])}`);
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
