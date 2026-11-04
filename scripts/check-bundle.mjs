import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(path.join(root,"src-tauri/tauri.conf.json"),"utf8"));
assert.equal(config.bundle.active,false,"Installer bundling must remain disabled");
const connections = config.app.security.csp.split(";").map(s=>s.trim()).find(s=>s.startsWith("connect-src "));
assert.ok(connections,"Production connection policy is required");
assert.ok(connections.split(/\s+/).slice(1).every(value=>["ipc:","http://ipc.localhost"].includes(value)),"The offline app must not connect to remote services");
const assets = path.join(root,"dist/assets");
const javascript = (await readdir(assets)).filter(name=>name.endsWith(".js"));
assert.ok(javascript.length,"Build the frontend before checking the bundle");
for (const name of javascript) {
  const code = await readFile(path.join(assets,name),"utf8");
  for (const forbidden of ["Preview-password-only-123!","A fictional test passphrase","alex@example.test","configure_pin","unlock_with_pin","remove_pin"]) {
    assert.ok(!code.includes(forbidden),`Production artifact contains a forbidden fixture or removed command: ${name}`);
  }
}
console.log("Production bundle: offline policy, no installer, no test secrets or PIN commands");
