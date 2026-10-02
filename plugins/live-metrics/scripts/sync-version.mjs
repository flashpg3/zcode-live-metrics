// Version single-source: propagate plugin.json's version to the
// two marketplace listings. Run after bumping the plugin version.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.resolve(pluginDir, "..", "..");
const version = JSON.parse(
  fs.readFileSync(path.join(pluginDir, ".zcode-plugin", "plugin.json"), "utf8"),
).version;

for (const rel of ["marketplace.json", path.join("plugins", "marketplace.json")]) {
  const file = path.join(root, rel);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = doc.plugins.find((p) => p.name === "live-metrics");
  if (!entry) throw new Error(`live-metrics entry not found in ${rel}`);
  if (entry.version !== version) {
    entry.version = version;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    console.log(`${rel}: -> ${version}`);
  } else {
    console.log(`${rel}: already ${version}`);
  }
}
