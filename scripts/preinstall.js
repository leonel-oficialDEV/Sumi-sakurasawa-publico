import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

if (process.env.DEPS_BUILD === '1') process.exit(0)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendor = path.join(root, 'vendor')
const vMods = path.join(vendor, 'node_modules')
const vHeaders = path.join(vendor, 'node-headers')
const mods = path.join(root, 'node_modules')
const envTag = `${process.platform}-${process.arch}-abi${process.versions.modules}`
const stamp = path.join(mods, `.built-${envTag}`)
const log = (m) => console.log(`[preinstall] ${m}`)

try {
  if (!fs.existsSync(vMods)) {
    log('falta vendor/node_modules, se omite (instalación normal).')
    process.exit(0)
  }

  const hFile = path.join(vHeaders, 'include', 'node', 'node_version.h')
  if (!fs.existsSync(hFile)) {
    log('faltan vendor/node-headers, se omite.')
    process.exit(0)
  }
  const h = fs.readFileSync(hFile, 'utf8')
  const get = (k) => (h.match(new RegExp(`#define NODE_${k}_VERSION (\\d+)`)) || [])[1]
  const hv = `${get('MAJOR')}.${get('MINOR')}.${get('PATCH')}`
  if (hv !== process.versions.node) {
    log(`headers v${hv} ≠ Node v${process.versions.node}, se omite. Regenera con fixvendor.`)
    process.exit(0)
  }

  if (fs.existsSync(stamp)) {
    log(`ya compilado para ${envTag}.`)
    process.exit(0)
  }

  log(`copiando vendor/node_modules y compilando para ${envTag}...`)

  fs.cpSync(vMods, mods, { recursive: true, force: true, verbatimSymlinks: true })

  execFileSync('npm', ['rebuild', '--foreground-scripts', '--offline', `--nodedir=${vHeaders}`], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      DEPS_BUILD: '1',
      npm_config_ignore_scripts: 'false',
      npm_config_build_from_source: 'true'
    }
  })

  fs.writeFileSync(stamp, new Date().toISOString())
  log('módulos compilados en node_modules, npm instalará el resto.')
} catch (e) {
  console.error(`[preinstall] ${String(e.message).slice(0, 300)}`)
  process.exit(0)
}