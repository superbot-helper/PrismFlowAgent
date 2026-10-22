import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CURRENT_PROCESS_START_IDENTITY, compareProcessStartIdentities, linuxProcessStartIdentity, processStartIdentityFor, validProcessStartIdentity } from '../lib/process-start-identity.js'
import { acquireWriterLease, inspectWriterLease } from '../lib/writer-lease-lock.js'

const BOOT = '11111111-1111-4111-8111-111111111111'
const owner = extra => ({ hostname: hostname(), pid: process.pid, nonce: '22222222-2222-4222-8222-222222222222', createdAt: new Date().toISOString(), ...extra })
function differentIdentity(identity) {
  const parts = identity.split(':'); parts[parts.length - 1] = String(BigInt(parts.at(-1)) + 1n); return parts.join(':')
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prismflow-process-birth-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, lock: join(root, 'writer.lock') }
}

test('Linux PID identity uses kernel boot ID and start ticks, including comm fields with nested parentheses', async t => {
  const { root } = await fixture(t)
  await mkdir(join(root, 'sys', 'kernel', 'random'), { recursive: true }); await mkdir(join(root, '39'))
  await writeFile(join(root, 'sys', 'kernel', 'random', 'boot_id'), `${BOOT}\n`)
  const fields = Array(20).fill('0'); fields[0] = 'S'; fields[19] = '12345'
  const stat = () => `39 (node (worker) with spaces) ${fields.join(' ')}\n`
  await writeFile(join(root, '39', 'stat'), stat())
  const first = linuxProcessStartIdentity(39, root)
  assert.equal(first, `linux-proc-v1:${BOOT}:12345`)
  fields[19] = '54321'; await writeFile(join(root, '39', 'stat'), stat())
  assert.equal(compareProcessStartIdentities(first, linuxProcessStartIdentity(39, root)), 'different')
  assert.equal(compareProcessStartIdentities(first, first), 'same')
  fields[19] = 'invalid'; await writeFile(join(root, '39', 'stat'), stat())
  assert.equal(linuxProcessStartIdentity(39, root), undefined)
  assert.equal(linuxProcessStartIdentity(40, root), undefined)
  assert.equal(compareProcessStartIdentities(first, undefined), 'unknown')
  assert.equal(compareProcessStartIdentities(first, 'process-start-epoch-ms:1234'), 'unknown')
  assert.equal(validProcessStartIdentity('argv:node web'), false)
})

test('a new-format live owner is never stolen because its timestamp predates the current process', async t => {
  const { lock } = await fixture(t)
  const data = owner({ processStartIdentity: CURRENT_PROCESS_START_IDENTITY, createdAt: '2020-01-01T00:00:00.000Z' })
  await writeFile(lock, JSON.stringify(data))
  await assert.rejects(acquireWriterLease(lock, { staleAgeMs: 1 }), /held by PID/u)
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), data)
})

test('a proven reused process identity is reclaimed without waiting a day, and an old disposer cannot unlink the new lease', async t => {
  const { lock } = await fixture(t)
  const releaseOld = await acquireWriterLease(lock)
  const prior = JSON.parse(await readFile(lock, 'utf8'))
  assert.equal(prior.processStartIdentity, CURRENT_PROCESS_START_IDENTITY)
  prior.processStartIdentity = differentIdentity(prior.processStartIdentity)
  await writeFile(lock, JSON.stringify(prior))
  assert.equal((await inspectWriterLease(lock)).state, 'dead-owner')
  const releaseNew = await acquireWriterLease(lock, { staleAgeMs: 24 * 60 * 60 * 1000 })
  const current = await readFile(lock, 'utf8')
  await releaseOld()
  assert.equal(await readFile(lock, 'utf8'), current)
  await releaseNew()
  await assert.rejects(readFile(lock), { code: 'ENOENT' })
})

test('a freshly exited identified owner is recovered immediately rather than leaving stores failed after a quick restart', async t => {
  const { lock } = await fixture(t)
  const moduleUrl = new URL('../lib/writer-lease-lock.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireWriterLease } from ${JSON.stringify(moduleUrl)}; await acquireWriterLease(${JSON.stringify(lock)}); process.exit(0)`], { stdio: 'ignore' })
  const [code] = await once(child, 'close')
  assert.equal(code, 0)
  const previous = JSON.parse(await readFile(lock, 'utf8'))
  assert.equal(validProcessStartIdentity(previous.processStartIdentity), true)
  const release = await acquireWriterLease(lock, { staleAgeMs: 24 * 60 * 60 * 1000 })
  await release()
  await assert.rejects(readFile(lock), { code: 'ENOENT' })
})

test('identity-family mismatch and malformed identity remain protected rather than treated as a reused PID', async t => {
  const { lock } = await fixture(t)
  const mismatch = CURRENT_PROCESS_START_IDENTITY.startsWith('linux-proc-v1:') ? 'process-start-epoch-ms:1' : `linux-proc-v1:${BOOT}:1`
  const data = owner({ processStartIdentity: mismatch, createdAt: '2020-01-01T00:00:00.000Z' })
  await writeFile(lock, JSON.stringify(data))
  await assert.rejects(acquireWriterLease(lock, { staleAgeMs: 1 }), /held by PID/u)
  data.processStartIdentity = 'unknown-process-identity'; await writeFile(lock, JSON.stringify(data))
  await assert.rejects(acquireWriterLease(lock), /malformed/u)
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), data)
})

test('a stale recovery owner with a reused birth identity is also reclaimed, without stealing foreign-host locks', async t => {
  const { lock } = await fixture(t)
  await writeFile(lock, JSON.stringify(owner({ pid: 2_000_000_000, createdAt: '2020-01-01T00:00:00.000Z' })))
  await writeFile(`${lock}.recovery`, JSON.stringify(owner({ processStartIdentity: differentIdentity(CURRENT_PROCESS_START_IDENTITY) })))
  const release = await acquireWriterLease(lock, { staleAgeMs: 1 }); await release()
  await assert.rejects(readFile(`${lock}.recovery`), { code: 'ENOENT' })
  const foreign = owner({ hostname: `${hostname()}-other`, processStartIdentity: differentIdentity(CURRENT_PROCESS_START_IDENTITY) })
  await writeFile(lock, JSON.stringify(foreign))
  await assert.rejects(acquireWriterLease(lock), /another hostname/u)
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), foreign)
})

test('Linux can distinguish a reused other PID from a genuine live subprocess owner', { skip: process.platform !== 'linux' }, async t => {
  const { lock } = await fixture(t)
  const child = spawn(process.execPath, ['-e', 'console.log("ready"); process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'inherit'] })
  try {
    await once(child.stdout, 'data')
    const identity = processStartIdentityFor(child.pid)
    if (!identity) return t.skip('kernel process identity is unavailable')
    const data = owner({ pid: child.pid, processStartIdentity: identity })
    await writeFile(lock, JSON.stringify(data))
    await assert.rejects(acquireWriterLease(lock), /held by PID/u)
    data.processStartIdentity = differentIdentity(identity); await writeFile(lock, JSON.stringify(data))
    const release = await acquireWriterLease(lock, { staleAgeMs: 24 * 60 * 60 * 1000 })
    await release()
  } finally { const exited = once(child, 'exit'); child.stdin.end(); await exited }
})
