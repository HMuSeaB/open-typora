import path from "node:path";
import fs from "node:fs";

// Electron development has an extra app-directory argument. Installed file
// associations pass the document after the executable on Windows.
export function launchFiles(argv, packaged, cwd = process.cwd()) {
  const args = argv.slice(packaged ? 1 : 2);
  const results = [];
  for (const raw of args) {
    if (!raw || raw.startsWith("-")) continue;
    try {
      const resolved = path.resolve(cwd, raw);
      if (fs.existsSync(resolved)) {
        results.push(resolved);
      } else if (/\.(md|markdown|mdown)$/i.test(raw)) {
        results.push(resolved);
      }
    } catch {}
  }
  return [...new Set(results)];
}
