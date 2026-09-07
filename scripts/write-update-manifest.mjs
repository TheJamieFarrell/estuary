// Runs after electron-builder: describes the freshly built installer so installed copies of
// Estuary can find and apply it (see src/main/updater.ts).
//
// The manifest is read two ways:
//   - locally, from a folder the dev points at with config/update-source.local.json
//   - publicly, from a GitHub release asset (update.json next to the installer)
// so it carries a sha512 + size that the app verifies after downloading.
//
// ESTUARY_PUBLIC=1 also copies the installer to a versionless `Estuary-Setup.exe` so the landing
// page can link to a stable URL (…/releases/latest/download/Estuary-Setup.exe).
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const release = join(root, 'release')
const file = readdirSync(release).find((f) => f === `Estuary-Setup-${pkg.version}.exe`)
if (!file) {
  console.error(`No installer for ${pkg.version} in ${release}`)
  process.exit(1)
}

const installer = join(release, file)
const bytes = readFileSync(installer)
const manifest = {
  version: pkg.version,
  file,
  // Base64 of the raw SHA-512 digest, the same encoding electron-builder uses in latest.yml.
  sha512: createHash('sha512').update(bytes).digest('base64'),
  size: bytes.byteLength,
  builtAt: Math.round(statSync(installer).mtimeMs),
  notes: process.env.ESTUARY_RELEASE_NOTES ?? ''
}
writeFileSync(join(release, 'update.json'), JSON.stringify(manifest, null, 2))
console.log('wrote release/update.json', manifest)

if (process.env.ESTUARY_PUBLIC === '1') {
  // A stable download name for the website. The manifest keeps pointing at the versioned file so
  // the updater still verifies the exact build it was told about.
  const stable = join(release, 'Estuary-Setup.exe')
  copyFileSync(installer, stable)
  console.log(`copied ${file} -> Estuary-Setup.exe`)
}
