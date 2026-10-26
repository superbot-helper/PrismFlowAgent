import { randomUUID } from 'node:crypto'
import { hostname as systemHostname } from 'node:os'
import { dirname, isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { CURRENT_PROCESS_START_IDENTITY, compareProcessStartIdentities, processStartIdentityFor, validProcessStartIdentity } from './process-start-identity.js'

// Retained for callers compiled against older releases. Proven-dead owners no
// longer wait on wall-clock age; staleAgeMs is validated but does not weaken or
// delay the recovery-lease and exact-owner checks.
export const WRITER_LOCK_STALE_AGE_MS = 30_000
const OWNER_FIELDS = ['hostname', 'pid', 'nonce', 'createdAt']
const CURRENT_PROCESS_STARTED_AT_MS = Math.floor(performance.timeOrigin)

export class WriterLeaseValidationError extends Error { constructor(message) { super(message); this.name = 'WriterLeaseValidationError' } }
export class WriterLeaseConflictError extends Error { constructor(message) { super(message); this.name = 'WriterLeaseConflictError' } }

function exact(value, fields) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}
function validOwner(value) {
  const legacy = exact(value, OWNER_FIELDS)
  if ((!legacy && (!exact(value, [...OWNER_FIELDS, 'processStartIdentity']) || !validProcessStartIdentity(value.processStartIdentity)))
    || typeof value.hostname !== 'string' || value.hostname.length < 1 || value.hostname.length > 255
    || /[\u0000-\u001f\u007f]/u.test(value.hostname) || !Number.isInteger(value.pid) || value.pid < 1 || value.pid > 2_147_483_647
    || typeof value.nonce !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.nonce)
    || typeof value.createdAt !== 'string' || value.createdAt.length > 40) return undefined
  const timestamp = Date.parse(value.createdAt)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.createdAt) return undefined
  return { ...value, timestamp }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code !== 'ESRCH' }
}
// A persistent container commonly assigns the same low PID after restart. For
// our own PID, a lock created before this Node process started belongs to the
// prior incarnation even though kill(pid, 0) now succeeds against us.
function ownerIsPriorCurrentPidIncarnation(owner) {
  return owner.pid === process.pid && owner.timestamp < CURRENT_PROCESS_STARTED_AT_MS
}
function ownerIsReused(owner) {
  if (owner.processStartIdentity !== undefined) {
    return compareProcessStartIdentities(owner.processStartIdentity, processStartIdentityFor(owner.pid)) === 'different'
  }
  // Four-field historical owners cannot identify another process incarnation.
  // Preserve only the existing own-PID legacy recovery; never guess that an
  // arbitrary live PID is stale based on a timestamp, argv or lock age.
  return ownerIsPriorCurrentPidIncarnation(owner)
}
function ownerProcessAlive(owner) {
  return processAlive(owner.pid) && !ownerIsReused(owner)
}
function heldOwnerMessage(owner, label = 'Writer lock') {
  return owner.processStartIdentity === undefined
    ? `${label} references active or unverifiable PID ${owner.pid}; this legacy owner has no process-start identity. Confirm all writers are stopped before archiving the old lock.`
    : `${label} is held by PID ${owner.pid}`
}
async function readOwner(path) {
  try { return validOwner(JSON.parse(await readFile(path, 'utf8'))) } catch { return undefined }
}
function sameOwner(left, right) {
  return left?.hostname === right.hostname && left?.pid === right.pid && left?.nonce === right.nonce && left?.createdAt === right.createdAt
    && left?.processStartIdentity === right.processStartIdentity
}
// The complete owner is fsynced in a same-directory candidate before its hard
// link is atomically published as the canonical lock. A crash can leave only an
// irrelevant candidate, never an empty/mid-write canonical owner.
async function publishOwner(path, owner) {
  const candidate = `${path}.candidate-${owner.nonce}`
  let handle
  try {
    handle = await open(candidate, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
    await handle.sync()
    const inode = (await handle.stat()).ino
    await handle.close(); handle = undefined
    await link(candidate, path)
    return inode
  } finally {
    await handle?.close().catch(() => {})
    await unlink(candidate).catch(() => {})
  }
}

async function removeExactOwner(path, owner, inode) {
  const current = await readOwner(path)
  if (!sameOwner(current, owner)) return false
  let currentStat
  try { currentStat = await stat(path) } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
  if (inode !== undefined && currentStat.ino !== inode) return false
  const confirmed = await readOwner(path)
  if (!sameOwner(confirmed, owner)) return false
  try { await unlink(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

async function reclaimStaleRecovery(recoveryPath, localHostname) {
  const owner = await readOwner(recoveryPath)
  if (!owner) throw new WriterLeaseConflictError(`Writer lock recovery owner is missing, malformed, or unreadable: ${recoveryPath}`)
  if (owner.hostname !== localHostname) throw new WriterLeaseConflictError(`Writer lock recovery is owned by another hostname: ${owner.hostname}`)
  if (ownerProcessAlive(owner)) throw new WriterLeaseConflictError(heldOwnerMessage(owner, 'Writer lock recovery'))
  const quarantine = `${recoveryPath}.stale-${randomUUID()}`
  try { await rename(recoveryPath, quarantine) }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error }
  const moved = await readOwner(quarantine)
  if (!sameOwner(moved, owner)) {
    throw new WriterLeaseConflictError(`Writer lock recovery changed during stale reclamation; inspect manually: ${quarantine}`)
  }
  await unlink(quarantine)
  return true
}

async function acquireRecovery(recoveryPath, owner) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const inode = await publishOwner(recoveryPath, owner)
      return {
        async assertOwned() {
          const current = await readOwner(recoveryPath)
          if (!sameOwner(current, owner) || (await stat(recoveryPath)).ino !== inode) {
            throw new WriterLeaseConflictError('Writer lock recovery ownership changed during reclamation')
          }
        },
        async release() { await removeExactOwner(recoveryPath, owner, inode) },
      }
    } catch (error) {
      if (!['EEXIST', 'EACCES', 'EPERM'].includes(error?.code)) throw error
      // EACCES/EPERM while publishing can mean the canonical path exists on
      // Windows. Reading it below still fails closed if that is not the case.
      const reclaimed = await reclaimStaleRecovery(recoveryPath, owner.hostname)
      if (!reclaimed) continue
    }
  }
  throw new WriterLeaseConflictError('Writer lock stale recovery could not be acquired')
}

/** Read-only, bounded diagnostic snapshot. Never use this result to authorize recovery. */
export async function inspectWriterLease(lockPath) {
  if (typeof lockPath !== 'string' || !isAbsolute(lockPath)) return { state: 'unconfigured' }
  let owner
  try {
    const info = await stat(lockPath)
    if (!info.isFile() || info.size > 4096) return { state: 'malformed' }
    owner = validOwner(JSON.parse(await readFile(lockPath, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' }
    if (error instanceof SyntaxError) return { state: 'malformed' }
    return { state: 'unreadable' }
  }
  if (!owner) return { state: 'malformed' }
  if (owner.hostname !== systemHostname()) return { state: 'foreign-host' }
  if (ownerProcessAlive(owner)) {
    if (owner.processStartIdentity === undefined && owner.pid !== process.pid) return { state: 'legacy-owner-unverified', pid: owner.pid }
    return { state: 'held', pid: owner.pid, sameProcess: owner.pid === process.pid }
  }
  return { state: 'dead-owner' }
}

/**
 * Acquires a process-lifetime, same-machine writer lease. Shared/network
 * filesystems and multi-host SQLite are intentionally unsupported.
 */
export async function acquireWriterLease(lockPath, options = {}) {
  if (!isAbsolute(lockPath)) throw new WriterLeaseValidationError('writerLockPath must be an absolute path')
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const settings = {
    hostname: options.hostname ?? systemHostname(),
    now: options.now ?? (() => Date.now()),
    staleAgeMs: options.staleAgeMs ?? WRITER_LOCK_STALE_AGE_MS,
  }
  if (!Number.isInteger(settings.staleAgeMs) || settings.staleAgeMs < 1) throw new WriterLeaseValidationError('Writer lock stale age is invalid')
  const owner = { hostname: settings.hostname, pid: process.pid, processStartIdentity: CURRENT_PROCESS_START_IDENTITY,
    nonce: randomUUID(), createdAt: new Date(settings.now()).toISOString() }
  const recoveryPath = `${lockPath}.recovery`
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const inode = await publishOwner(lockPath, owner)
      return async () => { await removeExactOwner(lockPath, owner, inode) }
    } catch (error) {
      if (!['EEXIST', 'EACCES', 'EPERM'].includes(error?.code)) throw error
      const existing = await readOwner(lockPath)
      if (!existing) throw new WriterLeaseConflictError(`Writer lock owner is missing, malformed, or unreadable: ${lockPath}`)
      if (existing.hostname !== settings.hostname) throw new WriterLeaseConflictError(`Writer lock is owned by another hostname: ${existing.hostname}`)
      if (ownerProcessAlive(existing)) throw new WriterLeaseConflictError(heldOwnerMessage(existing))
      const recoveryOwner = { ...owner, nonce: randomUUID(), createdAt: new Date(settings.now()).toISOString() }
      const recovery = await acquireRecovery(recoveryPath, recoveryOwner)
      try {
        await recovery.assertOwned()
        const confirmed = await readOwner(lockPath)
        if (!sameOwner(confirmed, existing) || confirmed.hostname !== settings.hostname || ownerProcessAlive(confirmed)) continue
        if (typeof options.onRecoveryAcquired === 'function') await options.onRecoveryAcquired({ lockPath, owner: structuredClone(confirmed) })
        await recovery.assertOwned()
        const inode = (await stat(lockPath)).ino
        await removeExactOwner(lockPath, confirmed, inode)
      } finally { await recovery.release() }
    }
  }
  throw new WriterLeaseConflictError('Writer lock could not be acquired')
}
