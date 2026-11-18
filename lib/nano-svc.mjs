// Nano 加速器适配器 —— 复用 nano-api.mjs 的全部能力，
// 只多一件事：把"客户端凭据从哪读"和"签到结果怎么归一"在这里钉死。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  getCheckinStatus,
  getUser,
  getSubscribe,
  checkin as nanoCheckin,
  resolveBase,
  fmtGb,
  fmtTime,
  dayOf,
} from './nano-api.mjs'

const REL_PREFS = [
  ['test.vpm.pha', 'nano', 'shared_preferences.json'],
  ['test.vpm.pha', 'shared_preferences.json'],
]

export function findPrefs(customDir) {
  const roots = []
  const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  roots.push(appdata)
  if (customDir && String(customDir).trim()) roots.unshift(String(customDir).trim())
  for (const root of roots) {
    for (const rel of REL_PREFS) {
      const p = join(root, ...rel)
      if (existsSync(p)) return p
    }
    // 自定义目录可能直接就是 shared_preferences.json 所在目录
    const direct = join(root, 'shared_preferences.json')
    if (existsSync(direct)) return direct
  }
  return ''
}

export function readClientToken(customDir) {
  const file = findPrefs(customDir)
  if (!file) return { token: '', source: 'none', email: '', file: '' }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const token = String(raw['flutter.token'] || '').trim()
    const email = String(raw['flutter.email'] || '').trim()
    if (token) return { token, source: 'client', email, file }
    return { token: '', source: 'none', email, file }
  } catch {
    return { token: '', source: 'none', email: '', file }
  }
}

function resolveToken(cfg = {}) {
  // 客户端那份优先：客户端重登会换 token，手填的会过期。
  const client = readClientToken(cfg.prefsDir)
  if (client.token) return client
  const manual = String(cfg.token || '').trim()
  if (manual) return { token: manual, source: 'manual', email: '', file: '' }
  return { token: '', source: 'none', email: '', file: client.file }
}

/**
 * ⚠️ 这里必须先把基址解析出来再往下传：底层 `call/once` 认的是 `base`，
 * 不是 `baseUrl`。漏了这一步就会在 `base.replace(...)` 上抛
 * `Cannot read properties of undefined (reading 'replace')`。
 */
async function optsOf(cfg) {
  const t = resolveToken(cfg)
  const base = await resolveBase({ baseUrl: cfg.baseUrl || '', timeout: 15000 })
  return {
    tokenInfo: t,
    opts: { token: t.token, base, timeout: 20000 },
  }
}

export function configured(cfg = {}) {
  const t = resolveToken(cfg)
  return { ok: !!t.token, tokenSource: t.source, email: t.email, prefsFile: t.file }
}

export async function status(cfg = {}) {
  const { tokenInfo, opts } = await optsOf(cfg)
  if (!tokenInfo.token) {
    return { ok: false, needLogin: true, reason: '没找到 Nano 的登录态：客户端没登录过，也没在设置里填 token' }
  }
  const [st, sub, info] = await Promise.all([getCheckinStatus(opts), getSubscribe(opts), getUser(opts)])
  if (!st.ok) return { ...st, tokenSource: tokenInfo.source, email: tokenInfo.email }
  const total = Number(sub.transferEnable || info.transferEnable || 0)
  const used = Number(sub.up || 0) + Number(sub.down || 0)
  return {
    ok: true,
    signedToday: !st.canCheckin && dayOf(st.lastCheckinAt) === dayOf(Math.floor(Date.now() / 1000)),
    canSignin: !!st.canCheckin,
    streakDays: Number(st.checkinDays || 0),
    lastCheckinAt: st.lastCheckinAt ? fmtTime(st.lastCheckinAt) : '',
    account: tokenInfo.email || info.email || '',
    planName: sub.planName || '',
    trafficLeft: total ? fmtGb(Math.max(0, total - used)) : '',
    trafficTotal: total ? fmtGb(total) : '',
    expireAt: info.expiredAt ? fmtTime(info.expiredAt) : '',
    todayReward: st.nextRewardTraffic || '',
    tokenSource: tokenInfo.source,
    prefsFile: tokenInfo.file,
  }
}

export async function signin(cfg = {}) {
  const { tokenInfo, opts } = await optsOf(cfg)
  if (!tokenInfo.token) {
    return { ok: false, needLogin: true, reason: '没找到 Nano 的登录态：客户端没登录过，也没在设置里填 token' }
  }
  const r = await nanoCheckin(opts)
  if (!r.ok) return { ...r, tokenSource: tokenInfo.source }
  const after = await status(cfg)
  return {
    ok: true,
    already: !!r.already,
    signedToday: after.ok ? after.signedToday : true,
    streakDays: after.ok ? after.streakDays : Number(r.checkinDays || 0),
    message: r.already ? '今天已经签到过了' : '签到成功',
    snapshot: after,
  }
}
