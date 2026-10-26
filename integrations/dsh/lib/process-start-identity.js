import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const LINUX_IDENTITY = /^linux-proc-v1:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:(?:0|[1-9]\d{0,29})$/u
const WINDOWS_IDENTITY = /^windows-process-filetime-v1:(?:0|[1-9]\d{0,19})$/u
const EPOCH_IDENTITY = /^process-start-epoch-ms:(?:0|[1-9]\d{0,15})$/u

/** Read kernel-owned birth identity, never argv, wall-clock age or PID alone. */
export function linuxProcessStartIdentity(pid, procRoot = '/proc') {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2_147_483_647) return undefined
  try {
    const bootId = readFileSync(join(procRoot, 'sys', 'kernel', 'random', 'boot_id'), 'utf8').trim()
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
    const commandEnd = stat.lastIndexOf(')')
    if (commandEnd < 2 || stat.slice(0, stat.indexOf(' ')) !== String(pid)) return undefined
    // The comm field can itself contain spaces and parentheses. Fields after
    // its final ')' start at state (field 3); starttime is field 22.
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u)
    const identity = `linux-proc-v1:${bootId}:${fields[19]}`
    return LINUX_IDENTITY.test(identity) ? identity : undefined
  } catch { return undefined }
}

function queryWindowsProcessFiletime(pid) {
  const bundled = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : ''
  const executable = bundled && existsSync(bundled) ? bundled : 'powershell.exe'
  const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture))`
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 5_000,
  })
  return !result.error && result.status === 0 ? String(result.stdout).trim() : undefined
}

/** Read the kernel-reported Windows process creation FILETIME for any visible PID. */
export function windowsProcessStartIdentity(pid, query = queryWindowsProcessFiletime) {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2_147_483_647 || typeof query !== 'function') return undefined
  try {
    const identity = `windows-process-filetime-v1:${query(pid)}`
    return WINDOWS_IDENTITY.test(identity) ? identity : undefined
  } catch { return undefined }
}

export const CURRENT_PROCESS_START_IDENTITY = (process.platform === 'linux'
  ? linuxProcessStartIdentity(process.pid)
  : process.platform === 'win32' ? windowsProcessStartIdentity(process.pid) : undefined)
  ?? `process-start-epoch-ms:${Math.max(0, Math.floor(performance.timeOrigin))}`

export function processStartIdentityFor(pid) {
  if (pid === process.pid) return CURRENT_PROCESS_START_IDENTITY
  if (process.platform === 'linux') return linuxProcessStartIdentity(pid)
  if (process.platform === 'win32') return windowsProcessStartIdentity(pid)
  return undefined
}

export function validProcessStartIdentity(value) {
  return typeof value === 'string' && value.length <= 128
    && (LINUX_IDENTITY.test(value) || WINDOWS_IDENTITY.test(value) || EPOCH_IDENTITY.test(value))
}

/** Different identity families or unreadable process metadata are not proof of death. */
export function compareProcessStartIdentities(expected, observed) {
  if (!validProcessStartIdentity(expected) || !validProcessStartIdentity(observed)) return 'unknown'
  const family = value => value.startsWith('linux-proc-v1:') ? 'linux'
    : value.startsWith('windows-process-filetime-v1:') ? 'windows' : 'epoch'
  if (family(expected) !== family(observed)) return 'unknown'
  return expected === observed ? 'same' : 'different'
}
