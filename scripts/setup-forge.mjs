// Downloads the latest Forge release (https://github.com/Card-Forge/forge)
// next to this project and configures it for Proliferate's Accurate mode.
//
//   npm run setup:forge            installs into ../forge
//   FORGE_DIR=D:/forge npm run setup:forge
//
// Forge gets its own data folder (../forge-data) so this never touches a
// Forge install you use yourself.

import { execFileSync, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forgeDir = resolve(process.env.FORGE_DIR ?? join(projectRoot, '..', 'forge'));
const dataDir = resolve(join(forgeDir, '..', 'forge-data'));

/** `java -version` output (Java prints it to stderr), or null if Java is missing. */
function checkJava() {
  const res = spawnSync('java', ['-version'], { encoding: 'utf8' });
  return res.error ? null : `${res.stdout}${res.stderr}`;
}

async function main() {
  const java = checkJava() ?? '';
  const version = Number(java.match(/version "(\d+)/)?.[1] ?? 0);
  if (version < 17) {
    console.error('Forge needs Java 17 or newer. Install it from https://adoptium.net and run this again.');
    process.exit(1);
  }

  if (existsSync(forgeDir) && readdirSync(forgeDir).some((f) => /^forge-gui-desktop-.*\.jar$/.test(f))) {
    console.log(`Forge is already installed in ${forgeDir}. Delete that folder to reinstall.`);
  } else {
    const release = await (await fetch('https://api.github.com/repos/Card-Forge/forge/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })).json();
    const asset = release.assets?.find((a) => /^forge-installer-.*\.tar\.bz2$/.test(a.name));
    if (!asset) throw new Error('Could not find a Forge release archive on GitHub.');
    console.log(`Downloading ${asset.name} (${(asset.size / 1e6).toFixed(0)} MB) from ${release.html_url} ...`);

    mkdirSync(forgeDir, { recursive: true });
    const archive = join(forgeDir, asset.name);
    const res = await fetch(asset.browser_download_url);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));

    console.log('Extracting ...');
    execFileSync('tar', ['-xjf', asset.name], { cwd: forgeDir, stdio: 'inherit' });
    rmSync(archive);
  }

  mkdirSync(join(dataDir, 'decks', 'commander'), { recursive: true });
  const slash = (p) => p.replace(/\\/g, '/');
  writeFileSync(
    join(forgeDir, 'forge.profile.properties'),
    `# Written by Proliferate: keep this Forge's data separate from any other Forge install.\nuserDir=${slash(dataDir)}\ncacheDir=${slash(dataDir)}/cache\ncardPicsDir=\ndecksDir=${slash(dataDir)}/decks\n`,
  );
  console.log(`Done. Forge is in ${forgeDir}, its data in ${dataDir}.`);
  console.log('Start the site with "npm run dev" and pick "Accurate (Forge)" on the Simulate tab.');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
