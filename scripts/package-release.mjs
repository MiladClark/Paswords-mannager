import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './check-version.mjs';
if (process.platform !== 'win32') throw new Error('Windows release packaging must run on Windows');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
execFileSync('powershell.exe', ['-NoProfile', '-File', fileURLToPath(new URL('./package-release.ps1', import.meta.url)), '-Version', pkg.version], { stdio: 'inherit' });
