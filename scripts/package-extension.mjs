import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./build-extension.mjs";

const source = fileURLToPath(new URL("../browser-extension/", import.meta.url));
const release = fileURLToPath(new URL("../release/", import.meta.url));
const manifest = JSON.parse(
  await readFile(path.join(source, "manifest.json"), "utf8"),
);
// The Store assigns the published ID. The local public key is for Load unpacked.
delete manifest.key;

const files = [
  "background.js",
  "capture.js",
  "content.js",
  "popup.js",
  "popup.html",
  "popup.css",
  "icons/16.png",
  "icons/32.png",
  "icons/48.png",
  "icons/128.png",
];
await mkdir(release, { recursive: true });
const staging = await mkdtemp(path.join(release, "edge-addons-"));
const destination = path.join(
  release,
  `PassWards-extension-${manifest.version}-edge-addons.zip`,
);
if (path.dirname(staging) !== path.resolve(release)) {
  throw new Error(
    "The staging directory must be inside the release directory.",
  );
}
try {
  await mkdir(path.join(staging, "icons"));
  await writeFile(
    path.join(staging, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  for (const file of files) {
    await copyFile(path.join(source, file), path.join(staging, file));
  }
  execFileSync(
    "tar.exe",
    ["-a", "-cf", "upload.zip", "manifest.json", ...files],
    {
      cwd: staging,
      stdio: "inherit",
    },
  );
  await rename(path.join(staging, "upload.zip"), destination);
} finally {
  await rm(staging, { recursive: true, force: true });
}
console.log(`Microsoft Edge Add-ons upload: ${destination}`);
