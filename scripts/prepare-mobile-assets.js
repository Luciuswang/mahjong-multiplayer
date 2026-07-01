const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'www');

const copyTargets = [
  'index.html',
  'app-config.js',
  'img',
  'audio'
];

function removeDir(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);

  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

removeDir(outDir);
fs.mkdirSync(outDir, { recursive: true });

for (const target of copyTargets) {
  const src = path.join(root, target);
  if (!fs.existsSync(src)) {
    console.warn(`skip missing asset: ${target}`);
    continue;
  }
  copyRecursive(src, path.join(outDir, target));
}

console.log(`mobile web assets prepared: ${outDir}`);
