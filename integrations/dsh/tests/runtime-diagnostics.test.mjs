import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prismFlowServiceDiagnostics } from '../lib/runtime-diagnostics.js'
import { acquireWriterLease, inspectWriterLease } from '../lib/writer-lease-lock.js'

const ctx = { get() { return undefined } }

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'prismflow-runtime-diagnostics-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  return { home, profile, binding: { dshHome: home, profileName: 'web' } }
}

test('healthy stores need no file access and unbound failed stores get bounded unknown diagnostics', async () => {
  assert.deepEqual(await prismFlowServiceDiagnostics({ get() { return {} } }, { dshHome: '/does-not-exist', profileName: 'web' }), {})
  const result = await prismFlowServiceDiagnostics(ctx)
  assert.deepEqual(Object.keys(result).sort(), ['generatorWorkflows', 'production', 'toolsets'])
  for (const row of Object.values(result)) assert.equal(row.state, 'unknown')
})

test('read-only lock inspection detects current-process duplicates, foreign hosts and malformed owners without touching them', async t => {
  const value = await fixture(t)
  const lock = join(value.home, 'writer.lock')
  assert.deepEqual(await inspectWriterLease(''), { state: 'unconfigured' })
  assert.deepEqual(await inspectWriterLease(lock), { state: 'missing' })
  const release = await acquireWriterLease(lock)
  try {
    const original = await readFile(lock, 'utf8')
    assert.deepEqual(await inspectWriterLease(lock), { state: 'held', pid: process.pid, sameProcess: true })
    assert.equal(await readFile(lock, 'utf8'), original)
  } finally { await release() }
  const foreign = JSON.stringify({ hostname: `${hostname()}-other`, pid: process.pid,
    nonce: '11111111-1111-4111-8111-111111111111', createdAt: new Date().toISOString() })
  await writeFile(lock, foreign)
  assert.deepEqual(await inspectWriterLease(lock), { state: 'foreign-host' })
  assert.equal(await readFile(lock, 'utf8'), foreign)
  await writeFile(lock, '{invalid')
  assert.deepEqual(await inspectWriterLease(lock), { state: 'malformed' })
  assert.equal(await readFile(lock, 'utf8'), '{invalid')
  assert.deepEqual(await inspectWriterLease(value.profile), { state: 'malformed' })
})

test('failed-store status diagnoses Profile lock configuration without leaking paths, owner payloads or Profile secrets', async t => {
  const value = await fixture(t)
  const lock = join(value.home, 'toolsets.lock')
  const release = await acquireWriterLease(lock)
  const patch = JSON.stringify([
    { id: 'prismflow-store-toolsets', disabled: false, config: { writerLockPath: lock, unrelatedSecret: 'DO_NOT_PROJECT_THIS_FIELD' } },
    { id: 'prismflow-store-production', disabled: true, config: {} },
    { id: 'prismflow-store-generator-workflows', disabled: false, config: { writerLockPath: '' } },
  ])
  await writeFile(join(value.profile, 'cordis.patch.yml'), patch)
  try {
    const result = await prismFlowServiceDiagnostics(ctx, value.binding)
    assert.equal(result.toolsets.state, 'held'); assert.match(result.toolsets.message, /同一 DSH 进程/u)
    assert.equal(result.production.state, 'disabled')
    assert.equal(result.generatorWorkflows.state, 'unconfigured')
    const json = JSON.stringify(result)
    for (const forbidden of [value.home, hostname(), 'nonce', 'DO_NOT_PROJECT_THIS_FIELD']) assert.equal(json.includes(forbidden), false)
    assert.equal(await readFile(join(value.profile, 'cordis.patch.yml'), 'utf8'), patch)
    await assert.rejects(access(join(value.home, 'storages', 'domain.sqlite')), { code: 'ENOENT' })
  } finally { await release() }
})

test('malformed Profile data produces a bounded diagnostic rather than failing the status endpoint', async t => {
  const value = await fixture(t)
  await writeFile(join(value.profile, 'cordis.patch.yml'), '- id: broken\n  config: [invalid\n')
  const result = await prismFlowServiceDiagnostics(ctx, value.binding)
  for (const row of Object.values(result)) assert.equal(row.state, 'profile-unreadable')
})
