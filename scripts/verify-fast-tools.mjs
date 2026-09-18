import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const packagePath = path.join(root, "app", "node_modules", "@waishnav", "devspace", "package.json");
const serverPath = path.join(root, "app", "node_modules", "@waishnav", "devspace", "dist", "server.js");
const required = [
  "list_directory_fast",
  "read_file_fast",
  "search_files_fast",
  "git_status_fast",
  "edit_file_fast",
  "write_file_fast",
  "multi_read_fast",
  "project_snapshot_fast",
  "project_search_fast",
  "git_summary_fast",
  "multi_edit_fast",
  "run_checks_fast",
];

if (!fs.existsSync(packagePath) || !fs.existsSync(serverPath)) {
  console.error("[fast-tools] DevSpace installation is incomplete.");
  process.exit(2);
}
const version = JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
const patchPath = path.join(root, "patches", `devspace-${version}`, "server.js");
if (!fs.existsSync(patchPath)) {
  console.error(`[fast-tools] DevSpace ${version} has no reviewed patch in this repository.`);
  process.exit(3);
}

const source = fs.readFileSync(serverPath, "utf8");
const missing = required.filter((name) => !source.includes(name));
if (missing.length) {
  console.error("[fast-tools] Missing tools:", missing.join(", "));
  console.error("[fast-tools] Run: node scripts/apply-fast-tools.mjs");
  process.exit(4);
}

console.log(`[fast-tools] OK: ${required.length} tools present, DevSpace ${version}.`);