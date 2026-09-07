// Runs after electron-builder: describes the freshly built installer so installed copies of
// UniMail can find and apply it (see src/main/updater.ts).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const release = join(root, 'release')
const file = readdirSync(release).find((f) => f === `UniMail-Setup-${pkg.version}.exe`)
if (!file) {
  console.error(`No installer for ${pkg.version} in ${release}`)
  process.exit(1)
}
const manifest = {
  version: pkg.version,
  file,
  builtAt: Math.round(statSync(join(release, file)).mtimeMs),
  notes: process.env.UNIMAIL_RELEASE_NOTES ?? ''
}
writeFileSync(join(release, 'update.json'), JSON.stringify(manifest, null, 2))
console.log('wrote release/update.json', manifest)
