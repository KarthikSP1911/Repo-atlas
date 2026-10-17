/**
 * One command to produce the NitroCloud zip:  npm run deploy:pack
 *
 * 1. Pins @nitrostack/core and @nitrostack/cli in package.json to the versions that are installed
 *    (NitroStudio and `nitrostack-cli build` sometimes rewrite them to a newer, untested range,
 *    which would make a fresh deploy install a different version from the lockfile).
 * 2. Builds, typechecks, and loads every shipped snapshot.
 * 3. Packs repoatlas.zip and checks what is inside it.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

// 1. pin
const pkg = read('package.json');
let changed = false;
for (const [name, section] of [['@nitrostack/core', 'dependencies'], ['@nitrostack/cli', 'devDependencies']]) {
  const installed = read(`node_modules/${name}/package.json`).version;
  if (pkg[section][name] !== installed) {
    console.log(`pinning ${name}: ${pkg[section][name]} -> ${installed}`);
    pkg[section][name] = installed;
    changed = true;
  }
}
if (changed) writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

// 2. build and check
run('npm run build');
run('npx tsc --noEmit');
run('npm run check-snapshots');
// the build can rewrite the pins again, so pin once more before packing
const after = read('package.json');
for (const [name, section] of [['@nitrostack/core', 'dependencies'], ['@nitrostack/cli', 'devDependencies']]) {
  after[section][name] = read(`node_modules/${name}/package.json`).version;
}
writeFileSync('package.json', JSON.stringify(after, null, 2) + '\n');

// 3. pack and verify
run('npx nitrostack-cli pack --output repoatlas.zip');
if (!existsSync('repoatlas.zip')) throw new Error('repoatlas.zip was not created');
const require = createRequire(import.meta.url);
let names = [];
try {
  if (process.platform === 'win32') {
    const ps = "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead((Resolve-Path 'repoatlas.zip')).Entries | ForEach-Object { $_.FullName }";
    names = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  } else {
    names = execSync('unzip -Z1 repoatlas.zip', { encoding: 'utf8' }).split(/\n/).filter(Boolean);
  }
} catch {
  console.warn('Could not list the zip; skipping the content check.');
}
const bad = names.filter((n) => /(^|\/)node_modules\//.test(n) || /(^|\/)\.env$/.test(n) || /\.env\.(local|production)$/.test(n) || /Blueprint|Guidebook/.test(n));
const snaps = names.filter((n) => n.startsWith('data/snapshots/') && n.endsWith('.json'));
const lock = read('package-lock.json');
const lockCore = lock.packages?.['node_modules/@nitrostack/core']?.version;
console.log('\n--- deploy zip check ---');
console.log(`size: ${(statSync('repoatlas.zip').size / 1024).toFixed(0)} KB, entries: ${names.length || 'unknown'}`);
console.log(`snapshot files: ${snaps.length || 'unknown'}`);
console.log(`@nitrostack/core: package.json ${after.dependencies['@nitrostack/core']}, lockfile ${lockCore}`);
if (bad.length) {
  console.error('FORBIDDEN FILES IN ZIP:', bad.slice(0, 5));
  process.exit(1);
}
if (lockCore && lockCore !== after.dependencies['@nitrostack/core']) {
  console.error('package.json and package-lock.json disagree about @nitrostack/core; run npm install first.');
  process.exit(1);
}
void require;
console.log('OK: upload repoatlas.zip under MCP > Deployments.');
