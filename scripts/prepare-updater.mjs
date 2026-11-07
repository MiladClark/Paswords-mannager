import assert from "node:assert/strict";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const [, , action, output] = process.argv;
const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url))).version;
const repo = "MiladClark/Paswords-mannager";
const asset = `PassWards-${version}-windows-x64-setup.exe`;
assert.match(version, /^\d+\.\d+\.\d+$/, "Stable updater releases require an X.Y.Z version");

if (action === "config") {
  const pubkey = process.env.PASSWARDS_UPDATE_PUBKEY?.trim();
  assert.ok(pubkey && /^[A-Za-z0-9+/=]+$/.test(pubkey), "Configure the PASSWARDS_UPDATE_PUBKEY repository variable");
  assert.ok(output, "Specify a path for the Tauri release configuration");
  await writeFile(output, JSON.stringify({
    bundle: { active: true, targets: ["nsis"], createUpdaterArtifacts: true, windows: { nsis: { installMode: "currentUser" } } },
    plugins: { updater: { pubkey, requireSignedVersion: true, windows: { installMode: "passive" } } },
  }));
} else if (action === "manifest") {
  const source = resolve("src-tauri/target/release/bundle/nsis", `PassWards_${version}_x64-setup.exe`);
  const signature = (await readFile(`${source}.sig`, "utf8")).trim();
  const decoded = Buffer.from(signature, "base64").toString("utf8");
  assert.match(decoded, new RegExp(`^trusted comment: .*\\bversion:${version.replaceAll(".", "\\.")}(?:\\s|$)`, "m"), "Installer signature must bind the release version");
  await copyFile(source, resolve("release", asset));
  const manifest = {
    version,
    platforms: { "windows-x86_64": {
      url: `https://github.com/${repo}/releases/download/v${version}/${asset}`,
      signature,
    } },
  };
  await writeFile(resolve("release/latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const checksum = createHash("sha256").update(await readFile(source)).digest("hex");
  const checksumPath = resolve("release/SHA256SUMS.txt");
  const portableChecksums = (await readFile(checksumPath, "utf8")).split(/\r?\n/)
    .filter(line => line && !line.endsWith(`  ${asset}`));
  await writeFile(checksumPath, [...portableChecksums, `${checksum}  ${asset}`, ""].join("\n"));
} else {
  throw new Error("Expected config or manifest");
}
