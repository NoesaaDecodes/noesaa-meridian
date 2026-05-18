import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const root = process.cwd();
const skippedDirs = new Set([".git", "node_modules"]);

function listJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skippedDirs.has(entry.name)) {
        files.push(...listJsFiles(path.join(dir, entry.name)));
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(path.join(dir, entry.name));
    }
  }

  return files;
}

let failed = false;
for (const file of listJsFiles(root)) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) {
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
