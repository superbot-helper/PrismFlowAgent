import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { inspectWriterLease } from './writer-lease-lock.js'

const STORES = [
  ['toolsets', 'prismToolsets', 'prismflow-store-toolsets'],
  ['production', 'prismProduction', 'prismflow-store-production'],
  ['generatorWorkflows', 'prismGeneratorWorkflows', 'prismflow-store-generator-workflows'],
]
const MESSAGES = {
  unknown: '服务尚未注册。请检查对应子插件的初始化错误；现有配置不会被清空。',
  'profile-unreadable': '无法读取 Profile 配置进行诊断。请检查目录权限及 DSH Home 是否正确。',
  disabled: '该存储服务在 Profile 中被停用。',
  unconfigured: 'Profile 未配置有效的绝对 writerLockPath；请停止 DSH 后运行安装器补齐配置。',
  missing: 'Profile 指定的写入锁不存在，但服务仍未启动。请检查对应子插件的存储或历史数据初始化错误。',
  malformed: '写入锁格式损坏或路径不是普通文件。为避免并发写入，未自动删除或接管。',
  unreadable: '无法读取 Profile 指定的写入锁。请检查路径、文件权限和挂载状态。',
  'foreign-host': '写入锁属于另一主机或旧容器。已拒绝自动接管；请确认没有其它写入实例，不要直接删锁。',
  'dead-owner': '写入锁记录属于已退出或已被复用的本机进程；当前服务启动已失败，因此不会在进程内自行重试。请确认没有其它 DSH 写入实例后重启一次，新版本会通过恢复租约自动接管，无需手工删除锁。',
}

/** Advisory only: inspect failed stores without opening or modifying their domains. */
export async function prismFlowServiceDiagnostics(ctx, binding) {
  const unavailable = STORES.filter(([, service]) => ctx.get(service) === undefined)
  if (!unavailable.length) return {}
  let rows
  let profileError = false
  if (binding) {
    try {
      const document = parseDocument(await readFile(join(binding.dshHome, 'profiles', binding.profileName, 'cordis.patch.yml'), 'utf8'), { uniqueKeys: true })
      rows = document.errors.length ? undefined : document.toJSON()
      if (!Array.isArray(rows)) throw new Error('Profile is not a sequence')
    } catch { profileError = true }
  }
  const diagnostics = {}
  for (const [key, , rowId] of unavailable) {
    let inspection = { state: profileError ? 'profile-unreadable' : 'unknown' }
    if (rows) {
      const matches = rows.filter(row => row?.id === rowId)
      if (matches.length === 1) {
        const row = matches[0]
        inspection = row.disabled === true ? { state: 'disabled' } : await inspectWriterLease(row.config?.writerLockPath)
      }
    }
    const message = inspection.state === 'legacy-owner-unverified'
      ? `旧格式写入锁引用本机 PID ${inspection.pid}，但未记录进程启动身份，不能据此认定它仍是旧 DSH。确认所有共享数据卷的写入实例已停止后，需对旧锁做一次离线归档；不要直接杀这个 PID。`
      : inspection.state === 'held'
        ? inspection.sameProcess
          ? '同一 DSH 进程已持有此写入锁。请检查是否重复加载了 PrismFlow 存储插件或重复配置了锁路径。'
          : `写入锁仍由本机 PID ${inspection.pid} 持有。请先确认并停止旧 DSH 实例。`
        : MESSAGES[inspection.state] ?? MESSAGES.unknown
    // Project only fixed state/message metadata. No raw Profile fields, paths,
    // lock contents, hostnames, credentials, or arbitrary exception messages.
    diagnostics[key] = { state: inspection.state, message }
  }
  return diagnostics
}
