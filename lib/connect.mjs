// WorkBuddy / TRAE 签到适配器。
//
// 这两家的登录态已经在 dsh-connect-workbuddy / dsh-connect-trae 插件里了，
// 它们各自开了只允许本机访问的 HTTP 路由。我们不重新实现登录，
// 直接请这两个插件替我们签到 —— 少写两千行，也不会跟它们抢 token。
//
// 路由是 requireLoopback：Host 和 Origin 都必须指到本机同一个 authority，否则 403。
//
// ⚠️ 多账号这件事（2026-11-18 踩过）：这两个插件的 `/checkin` 路由都只签
// **当前选中**的那个账号 —— workbuddy 的 handler 里是 `store.resolve()`，
// 它压根不认 accountId 参数。要签全部账号必须走 `/pool?action=checkin`，
// 那个 handler 用 `checkinAllAccounts(poolTargets(region), poolRunnerDeps(region))`，
// 逐个账号 `store.credentialFor(accountId)`（只取凭据，不切换选择状态，所以
// 不会把你正在走的流量切到别的账号上）。
//
// 于是这里的策略是：**先打 /pool 批量，失败（没开池子 / 池子空 / 不支持签到）再退回 /checkin 单账号**。

/** `/pool` 的 row.status 取值：claimed / already / failed / skipped */
const POOL_STATUS = {
  claimed: { checkedIn: true, justSigned: true },
  already: { checkedIn: true, justSigned: false },
  failed: { checkedIn: false, justSigned: false },
  skipped: { checkedIn: false, justSigned: false, skipped: true },
}

/**
 * DSH 自己的地址。调用方（index.js）会把 `__selfBase` 塞进来，正常路径走不到兜底。
 *
 * ⚠️ 不要在这里写死端口：DSH 每次重启都换端口，写死的那个在别人机器上必然错。
 * 环境变量也没有就直接报错 —— 比默默打一个错端口、然后报"连不上"更好定位。
 */
function baseOf(opts) {
  const b = opts.selfBase || process.env.DSH_WEB_URL
  if (!b) {
    throw new Error('不知道 DSH 自己的地址：请在设置页「高级」里填上，或给进程环境变量 DSH_WEB_URL')
  }
  return String(b).replace(/\/+$/, '')
}

async function hit(path, opts = {}) {
  let base
  try {
    base = baseOf(opts)
  } catch (e) {
    return { ok: false, reason: e.message }
  }
  const authority = base.replace(/^https?:\/\//, '')
  const url = `${base}${path}`
  let res
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        host: authority,
        origin: base,
        accept: 'application/json',
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeout ?? 60000),
    })
  } catch (e) {
    return { ok: false, reason: `连不上 DSH 自己的 ${path}：${e.message}` }
  }
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      reason: (json && (json.error || json.reason || json.message)) || `HTTP ${res.status} ${String(text).slice(0, 160)}`,
    }
  }
  if (!json) return { ok: false, status: res.status, reason: `${path} 没返回 JSON` }
  return { ok: true, json }
}

/**
 * 把某家的账号表归一成 hub 的统一形状。
 *
 * ⚠️ `pool.accounts[*]` 里的字段名是 **`checkedInToday`**（不是 `checkedIn`）——
 * 顶层 `checkin` 对象那个 `todayCheckedIn` / `checkedIn` 是"当前账号"的，
 * 两个层级的命名都不一样，踩过一次。
 */
function rowOf(a) {
  return {
    id: a.accountId || a.id || '',
    name: a.accountName || a.name || '',
    checkedIn: a.checkedInToday === true || a.checkedIn === true,
    skipped: a.skipped === true,
    credits: typeof a.credits === 'number' ? a.credits : null,
    current: a.current === true || a.selected === true,
    message: a.message || '',
  }
}

/** `pool.accounts` 是我们唯一能拿到**逐账号**签到状态的地方（顶层 `checkin` 只反映选中的那个） */
function poolRows(j) {
  const list = (j && j.pool && Array.isArray(j.pool.accounts) && j.pool.accounts) || []
  return list.map(rowOf)
}

/** 汇总：跳过的账号不算"没签"（它本来就签不了），其余全签了才算全签 */
function rollup(rows) {
  const live = rows.filter((r) => !r.skipped)
  return {
    accounts: rows,
    signedToday: live.length > 0 && live.every((r) => r.checkedIn),
    signedCount: live.filter((r) => r.checkedIn).length,
    totalCount: live.length,
    skippedCount: rows.filter((r) => r.skipped).length,
    failed: live.filter((r) => !r.checkedIn).map((r) => r.name || r.id),
  }
}

/** 批量签到：`/pool?action=checkin`。失败返回 ok:false 让调用方决定要不要退回单账号 */
async function poolCheckin(pluginPath, opts = {}) {
  const region = opts.region || 'cn'
  const r = await hit(`/plugins/${pluginPath}/pool?region=${region}&action=checkin`, {
    ...opts,
    method: 'POST',
    body: '{}',
  })
  if (!r.ok) return r
  const rows = (r.json && Array.isArray(r.json.rows) && r.json.rows) || []
  if (rows.length === 0) return { ok: false, reason: `${pluginPath} 的池子返回了 0 行` }
  return { ok: true, rows: rows.map((row) => {
    const s = POOL_STATUS[row.status] || { checkedIn: false, justSigned: false }
    return {
      id: row.accountId || '',
      name: row.accountName || '',
      checkedIn: s.checkedIn,
      skipped: s.skipped === true,
      justSigned: s.justSigned === true,
      credits: typeof row.credit === 'number' ? row.credit : null,
      current: false,
      message: row.message || '',
    }
  }) }
}

// ---------- WorkBuddy ----------

export async function workbuddyStatus(opts = {}) {
  const r = await hit(`/plugins/dsh-connect-workbuddy/usage?region=${opts.region || 'cn'}`, opts)
  if (!r.ok) return r
  const j = r.json
  const ck = j.checkin || {}
  // 顶层 checkin 只反映**当前选中**的账号；多账号要看 pool.accounts
  const rows = poolRows(j)
  const sum = rows.length > 0
    ? rollup(rows)
    : { accounts: [], signedToday: !!ck.todayCheckedIn, signedCount: ck.todayCheckedIn ? 1 : 0, totalCount: 1, skippedCount: 0, failed: [] }
  const cur = rows.find((a) => a.current) || null
  return {
    ok: true,
    ready: ck.active !== false,
    signedToday: sum.signedToday,
    streakDays: Number(ck.streakDays || 0),
    todayCredit: Number(ck.todayCredit || 0),
    dailyCredit: Number(ck.dailyCredit || 0),
    account: cur ? cur.name : (j.accountName || ''),
    accounts: sum.accounts,
    signedCount: sum.signedCount,
    totalCount: sum.totalCount,
    skippedCount: sum.skippedCount,
    unsigned: sum.failed,
  }
}

export async function workbuddySignin(opts = {}) {
  const region = opts.region || 'cn'
  const pool = await poolCheckin('dsh-connect-workbuddy', opts)
  if (!pool.ok) {
    // 退回单账号：/checkin 只签当前选中的那个
    const r = await hit(`/plugins/dsh-connect-workbuddy/checkin?region=${region}`, {
      ...opts,
      method: 'POST',
      body: '{}',
    })
    if (!r.ok) return { ok: false, reason: `${pool.reason}；单账号签到也失败：${r.reason}` }
    const j = r.json
    const ck = j.checkin || {}
    return {
      ok: true,
      already: !!j.alreadyCheckedIn,
      signedToday: !!ck.todayCheckedIn,
      streakDays: Number(ck.streakDays || 0),
      todayCredit: Number(ck.todayCredit || 0),
      accounts: [],
      message: (j.alreadyCheckedIn ? '今天已经签过了' : '签到成功') + '（只有当前账号，池子批量不可用）',
      partial: true,
    }
  }
  // 批量签完再读一次 usage：既拿到每人的最终状态，也顺带刷新 credits
  const after = await workbuddyStatus(opts).catch(() => null)
  const rows = after && after.ok ? after.accounts : pool.rows
  const sum = rollup(rows)
  const claimed = pool.rows.filter((r) => r.justSigned).length
  const already = pool.rows.filter((r) => r.checkedIn && !r.justSigned).length
  const bits = []
  if (claimed) bits.push(`${claimed} 个账号签到成功`)
  if (already) bits.push(`${already} 个今天已经签过`)
  if (sum.failed.length) bits.push(`${sum.failed.length} 个失败（${sum.failed.join('、')}）`)
  if (sum.skippedCount) bits.push(`${sum.skippedCount} 个企业号没有签到活动`)
  return {
    ok: sum.failed.length === 0 || sum.signedCount > 0,
    already: claimed === 0,
    signedToday: sum.signedToday,
    streakDays: after && after.ok ? after.streakDays : 0,
    todayCredit: after && after.ok ? after.todayCredit : 0,
    accounts: rows,
    signedCount: sum.signedCount,
    totalCount: sum.totalCount,
    message: bits.join('，') || '全部账号今天已经签过了',
  }
}

// ---------- TRAE ----------

export async function traeStatus(opts = {}) {
  const r = await hit(`/plugins/dsh-connect-trae/usage?region=${opts.region || 'cn'}`, opts)
  if (!r.ok) return r
  const j = r.json
  const ck = j.checkin || {}
  const rows = poolRows(j)
  const sum = rows.length > 0
    ? rollup(rows)
    : { accounts: [], signedToday: !!ck.checkedIn, signedCount: ck.checkedIn ? 1 : 0, totalCount: 1, skippedCount: 0, failed: [] }
  const cur = rows.find((a) => a.current) || null
  return {
    ok: true,
    ready: ck.enabled !== false,
    signedToday: sum.signedToday,
    deviceSigned: !!ck.didCheckedIn,
    todayCredit: Number(ck.credits || 0),
    account: cur ? cur.name : (j.accountName || ''),
    accounts: sum.accounts,
    signedCount: sum.signedCount,
    totalCount: sum.totalCount,
    skippedCount: sum.skippedCount,
    unsigned: sum.failed,
  }
}

export async function traeSignin(opts = {}) {
  const region = opts.region || 'cn'
  const pool = await poolCheckin('dsh-connect-trae', opts)
  if (!pool.ok) {
    const body = opts.accountId ? JSON.stringify({ accountId: opts.accountId }) : '{}'
    const r = await hit(`/plugins/dsh-connect-trae/checkin?region=${region}`, {
      ...opts,
      method: 'POST',
      body,
    })
    if (!r.ok) return { ok: false, reason: `${pool.reason}；单账号签到也失败：${r.reason}` }
    const j = r.json
    const ck = j.checkin || {}
    return {
      ok: true,
      already: !!j.alreadyCheckedIn,
      signedToday: !!ck.checkedIn,
      deviceSigned: !!ck.didCheckedIn,
      todayCredit: Number(ck.credits || 0),
      accounts: [],
      message: (j.alreadyCheckedIn ? '今天已经签过了' : '签到成功') + '（只有当前账号，池子批量不可用）',
      partial: true,
    }
  }
  const after = await traeStatus(opts).catch(() => null)
  const rows = after && after.ok ? after.accounts : pool.rows
  const sum = rollup(rows)
  const claimed = pool.rows.filter((r) => r.justSigned).length
  const already = pool.rows.filter((r) => r.checkedIn && !r.justSigned).length
  const bits = []
  if (claimed) bits.push(`${claimed} 个账号签到成功`)
  if (already) bits.push(`${already} 个今天已经签过`)
  if (sum.failed.length) bits.push(`${sum.failed.length} 个失败（${sum.failed.join('、')}）`)
  return {
    ok: sum.failed.length === 0 || sum.signedCount > 0,
    already: claimed === 0,
    signedToday: sum.signedToday,
    deviceSigned: after && after.ok ? after.deviceSigned : false,
    todayCredit: after && after.ok ? after.todayCredit : 0,
    accounts: rows,
    signedCount: sum.signedCount,
    totalCount: sum.totalCount,
    message: bits.join('，') || '全部账号今天已经签过了',
  }
}
