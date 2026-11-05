import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = path.join(packageRoot, "src");
const outputRoot = path.join(packageRoot, "dist");
const publicAssets = [
  "index.html",
  "styles.css",
  "site.js",
  "story.js",
  "yarn-scene.js",
  "untangle-logo.svg",
  "untangle-yarn-3d.png",
  "untangle-example.html",
  "untangle-example.json",
];

await rm(outputRoot, { force: true, recursive: true });
await mkdir(outputRoot, { recursive: true });

for (const asset of publicAssets) {
  await copyFile(path.join(sourceRoot, asset), path.join(outputRoot, asset));
}

console.log(`website build: copied ${String(publicAssets.length)} static assets to dist/.`);
