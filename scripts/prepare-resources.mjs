// Runs before electron-builder (see "predist" in package.json).
// Copies the developer's personal, gitignored config into build-resources/ so the LOCAL build
// seeds OAuth client ids and the update source. Public builds (ESTUARY_PUBLIC=1) ship none of it:
// users bring their own OAuth client via Settings, and updates come from GitHub Releases.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const out = join(root, 'build-resources')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const isPublic = process.env.ESTUARY_PUBLIC === '1'
const personal = [
  ['config/oauth-clients.local.json', 'oauth-clients.json'],
  ['config/update-source.local.json', 'update-source.json']
]
if (!isPublic) {
  for (const [from, to] of personal) {
    const src = join(root, from)
    if (existsSync(src)) copyFileSync(src, join(out, to))
  }
}
console.log(`prepare-resources: ${isPublic ? 'PUBLIC build (no personal config)' : 'local build'} -> ${readdirSync(out).join(', ') || '(empty)'}`)
