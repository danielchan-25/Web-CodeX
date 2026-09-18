import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const appRoot = path.join(root, "app");
const packagePath = path.join(appRoot, "node_modules", "@waishnav", "devspace", "package.json");
const target = path.join(appRoot, "node_modules", "@waishnav", "devspace", "dist", "server.js");

if (!fs.existsSync(packagePath) || !fs.existsSync(target)) {
  console.error("[fast-tools] DevSpace is not installed. Run install.bat / npm install first.");
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const version = pkg.version;
const patch = path.join(root, "patches", `devspace-${version}`, "server.js");

if (!fs.existsSync(patch)) {
  console.error(`[fast-tools] No compatible patch for DevSpace ${version}.`);
  console.error("[fast-tools] Refusing to overwrite an unreviewed DevSpace version.");
  process.exit(3);
}
const backupDir = path.join(root, "fast-tools-backup");
fs.mkdirSync(backupDir, { recursive: true });
const original = path.join(backupDir, `server.original-${version}.js`);

if (!fs.existsSync(original)) {
  fs.copyFileSync(target, original);
}

fs.copyFileSync(patch, target);
console.log(`[fast-tools] Applied patch for DevSpace ${version}.`);
console.log(`[fast-tools] Target: ${target}`);