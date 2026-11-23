import { lstat, mkdir, rm, symlink } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const linkPath = resolve(projectRoot, 'node_modules/zeppos-app-utils')
const bundledPath = resolve(
  projectRoot,
  'node_modules/@zeppos/zeus-cli/private-modules/zeppos-app-utils'
)

await lstat(bundledPath)
await rm(linkPath, { recursive: true, force: true })
await mkdir(dirname(linkPath), { recursive: true })
await symlink(relative(dirname(linkPath), bundledPath), linkPath, 'dir')
