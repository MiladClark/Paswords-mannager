import { writeFileSync } from "node:fs";
// PassWards: an open ward with a W base protecting a password asterisk.
// Keep these paths in sync with the theme-aware mark in App.tsx.
const enclosure = "M20 8 8 16v29l12 11 12-10 12 10 12-11V16L44 8";
const asterisk = "M32 19v20M23.34 24l17.32 10M23.34 34l17.32-10";
const mark = `<g fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path stroke="#eeefeb" d="${enclosure}"/><path stroke="#67a8b8" d="${asterisk}"/></g>`;
const transparent = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 64 64">${mark}</svg>\n`;
writeFileSync(new URL("../app-icon.svg", import.meta.url), transparent);
writeFileSync(new URL("../assets/branding/passwards-mark-linear.svg", import.meta.url), transparent);
writeFileSync(
  new URL("../assets/branding/passwards-app-icon-linear.svg", import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1c2024"/><g transform="translate(6.4 6.4) scale(.8)">${mark}</g></svg>\n`,
);
