import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "browser-extension");
const identity = JSON.parse(
  await readFile(path.join(directory, "identity.json"), "utf8"),
);
const manifest = {
  manifest_version: 3,
  name: "PassWards",
  version: "0.5.3",
  description:
    "Save, update and fill logins with your offline PassWards vault. Desktop approval required.",
  key: identity.key,
  minimum_chrome_version: "120",
  permissions: [
    "nativeMessaging",
    "storage",
    "scripting",
    "activeTab",
    "favicon",
  ],
  host_permissions: ["https://*/*", "http://*/*"],
  content_scripts: [
    {
      matches: ["https://*/*", "http://*/*"],
      js: ["content.js"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
  background: { service_worker: "background.js", type: "module" },
  action: {
    default_popup: "popup.html",
    default_title: "PassWards",
    default_icon: {
      16: "icons/16.png",
      32: "icons/32.png",
      48: "icons/48.png",
      128: "icons/128.png",
    },
  },
  icons: {
    16: "icons/16.png",
    32: "icons/32.png",
    48: "icons/48.png",
    128: "icons/128.png",
  },
  commands: {
    _execute_action: {
      suggested_key: { default: "Alt+Shift+P" },
      description: "Open PassWards",
    },
  },
  content_security_policy: {
    extension_pages:
      "script-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'",
  },
};
await mkdir(path.join(directory, "icons"), { recursive: true });
// Existing native raster assets are used for the extension too.
for (const size of [16, 32, 48, 128])
  await copyFile(
    path.join(
      root,
      "src-tauri/icons",
      size <= 32 ? "32x32.png" : "128x128.png",
    ),
    path.join(directory, "icons", `${size}.png`),
  );
await writeFile(
  path.join(directory, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(`Extension ready: ${directory}\nChrome / Edge ID: ${identity.id}`);
