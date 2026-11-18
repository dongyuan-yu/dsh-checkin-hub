/**
 * lib/http.mjs —— 零依赖的 HTTPS 客户端（可选走本机代理）+ 一个够用的 cookie 罐
 * ============================================================================
 * 🔴 为什么不用 `fetch`（这是本插件最要紧的一条环境事实）：
 *   Node 内置的 `fetch` **不认 HTTP_PROXY / HTTPS_PROXY**，也不读 Windows 的系统代理设置。
 *   而雅书这类站在国内不少网络里是**必须走代理才连得上**的（这台机器上就是这样：
 *   直连 `connect to 207.56.22.245:443 failed: Timed out`，走 `127.0.0.1:7897` 立刻 200）。
 *   早期我们用 `.extra('volatile')` 之外啥也没想就写了 `fetch`，结果插件在宿主里永远签不上——
 *   而设置页上看起来一切正常。**这种"静默不通"最难查，所以干脆自己写这一层。**
 *
 *   代价只有几十行：`http.request(CONNECT)` 打个隧道 → `tls.connect` 在隧道上起 TLS →
 *   `https.request({ agent: false, createConnection })` 复用这条 socket。
 *   好处是 **不依赖 undici / proxy-agent 之类任何包**（桌面版 profile 是 autoInstallPeers:false，
 *   多一个裸依赖就多一次"整条插件不激活"的机会 ✗）。
 *
 * ⚠️ 另一条踩过的：`https.request` 的官方出口是 `options.createConnection`，
 *    但**只在 `agent: false` 时才会被用**（Node 文档原话："when the agent option is not used"）。
 *    两个一起写才对 —— 只写 createConnection 而 agent 还在，它会自己开一条新连接，
 *    于是代理形同虚设、请求从本机直连出去、超时。
 * ============================================================================
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { execFile } from 'node:child_process'

export const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 这条请求总共给多久（毫秒）。签个到而已，30 秒足够，卡住就当失败重试 */
const DEFAULT_TIMEOUT = 30_000

/**
 * Cookie 罐 —— 够用就好。
 * 雅书（帝国CMS）的 cookie 都是 `name=value; path=/; secure` 这种最朴素的形式，
 * 没有 domain 前缀、没有 SameSite 的特殊要求，所以按 name 覆盖存就够了。
 */
export class CookieJar {
  constructor(init) {
    this.map = new Map()
    if (init && typeof init === 'object') {
      for (const [k, v] of Object.entries(init)) this.map.set(k, String(v))
    }
  }

  /** 从响应头里收 `set-cookie`（Node 已把它归成数组） */
  absorb(setCookie) {
    if (!setCookie) return
    const list = Array.isArray(setCookie) ? setCookie : [setCookie]
    for (const raw of list) {
      const first = String(raw).split(';')[0]
      const eq = first.indexOf('=')
      if (eq <= 0) continue
      const name = first.slice(0, eq).trim()
      const value = first.slice(eq + 1).trim()
      // 站点用 `name=deleted; expires=过去` 来删 cookie —— 照做，别把空值当成有效凭证
      if (!name) continue
      if (/expires=Thu, 01 Jan 1970/i.test(raw) || value === 'deleted') this.map.delete(name)
      else this.map.set(name, value)
    }
  }

  /** 给下一次请求用的 Cookie 头（空罐返回空串，让调用方自己决定要不要带） */
  header() {
    if (!this.map.size) return ''
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  has(name) { return this.map.has(name) }
  get(name) { return this.map.get(name) }
  toJSON() { return Object.fromEntries(this.map) }
}

/** 打个加密隧道（CONNECT）。返回一条**裸 TCP socket**，TLS 由调用方在上面起 */
function tunnel(proxyUrl, host, port, timeout) {
  return new Promise((resolve, reject) => {
    let p
    try { p = new URL(proxyUrl) } catch { reject(new Error(`代理地址看不懂：${proxyUrl}`)); return }
    if (p.protocol !== 'http:') { reject(new Error(`只支持 http:// 代理，现在给的是 ${p.protocol}`)); return }

    const headers = {}
    if (p.username) {
      const auth = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || '')}`
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(auth, 'utf8').toString('base64')
    }

    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      timeout,
    })
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理拒绝建立隧道：HTTP ${res.statusCode}`))
        return
      }
      resolve(socket)
    })
    req.once('timeout', () => { req.destroy(new Error('连代理超时')) })
    req.once('error', reject)
    req.end()
  })
}

/** 在裸 socket 上起 TLS，返回已握手的 TLSSocket */
function tlsOver(socket, servername, timeout) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername, ALPNProtocols: ['http/1.1'] })
    const done = (fn, arg) => { s.removeAllListeners('secureConnect'); s.removeAllListeners('error'); s.setTimeout(0); fn(arg) }
    s.setTimeout(timeout, () => { s.destroy(); reject(new Error('TLS 握手超时')) })
    s.once('secureConnect', () => done(resolve, s))
    s.once('error', (e) => done(reject, e))
  })
}

/** 解掉 gzip / deflate / br（服务器不一定听我们的，所以按响应头来） */
function decodeBody(buf, encoding) {
  const enc = String(encoding || '').toLowerCase().trim()
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf)
    if (enc === 'deflate') return zlib.inflateSync(buf)
    if (enc === 'br') return zlib.brotliDecompressSync(buf)
  } catch { /* 解不开就按原样给，反正下面按文本处理 */ }
  return buf
}

/**
 * 发一个请求。
 * @returns {Promise<{status:number, headers:object, text:string, json:any, url:string}>}
 *
 * 设计上故意**只支持 https**（雅书就是 https，隧道也好写）；
 * 万一以后要 http，把 tlsOver 那段按协议跳过即可。
 */
export async function request(opts) {
  const {
    url,
    method = 'GET',
    headers = {},
    body = null,
    proxy = '',
    timeout = DEFAULT_TIMEOUT,
    jar = null,
    redirect = 3,
  } = opts || {}

  const u = new URL(url)
  if (u.protocol !== 'https:') throw new Error(`只支持 https，收到 ${u.protocol}`)

  const host = u.hostname
  const port = Number(u.port) || 443
  const pathWithQuery = u.pathname + (u.search || '')

  const finalHeaders = {
    'User-Agent': DEFAULT_UA,
    'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    // ⚠️ 故意**不**主动要 gzip：少数站点会无视 Accept-Encoding 塞压缩体，
    //    而帝国CMS 的提示页是纯 HTML，不压缩对我们最省事。真压缩了下面也会解。
    'Host': u.host,
    ...headers,
  }
  const cookieHeader = jar ? jar.header() : ''
  if (cookieHeader) finalHeaders['Cookie'] = cookieHeader
  if (body != null) finalHeaders['Content-Length'] = Buffer.byteLength(body)

  const send = async (useProxy) => new Promise((resolve, reject) => {
    const start = async () => {
      let createConnection
      let agent = false
      if (useProxy) {
        const raw = await tunnel(useProxy, host, port, timeout)
        const secure = await tlsOver(raw, host, timeout)
        createConnection = () => secure
      } else {
        // 直连：把 agent 关掉，别让它复用连接（每次签到都是一次性会话，不差这点开销）
        agent = false
      }
      const req = https.request({
        hostname: host,
        port,
        path: pathWithQuery,
        method,
        headers: finalHeaders,
        agent,
        ...(createConnection ? { createConnection } : {}),
        timeout,
      })
      const chunks = []
      req.once('response', (res) => {
        res.on('data', (c) => chunks.push(c))
        res.once('end', () => {
          const raw = decodeBody(Buffer.concat(chunks), res.headers['content-encoding'])
          resolve({ status: res.statusCode || 0, headers: res.headers, buffer: raw, url })
        })
        res.once('error', reject)
      })
      req.once('timeout', () => { req.destroy(new Error('请求超时')) })
      req.once('error', reject)
      if (body != null) req.write(body)
      req.end()
    }
    start().catch(reject)
  })

  let res
  let usedProxy = proxy
  if (proxy) {
    try {
      res = await send(proxy)
    } catch (e) {
      // 代理挂了 / 端口没开 ⇒ 退回直连试一次（有些机器只在部分网络下需要代理）
      usedProxy = ''
      res = await send('')
    }
  } else {
    res = await send('')
  }

  if (jar) jar.absorb(res.headers['set-cookie'])

  // 跟一次跳转（帝国CMS 的 `/e/member/sign` 无尾斜杠会 301，带了尾斜杠也可能被踢去登录页）
  const loc = res.headers['location']
  if (loc && [301, 302, 303, 307, 308].includes(res.status) && redirect > 0) {
    const next = new URL(loc, url).href
    return request({ ...opts, url: next, method: res.status === 303 ? 'GET' : method, redirect: redirect - 1 })
  }

  const text = res.buffer.toString('utf8')
  let json = null
  const t = text.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try { json = JSON.parse(t) } catch { /* 不是 JSON 就算了 —— 帝国CMS 出错时会给一整页 HTML */ }
  }

  return { status: res.status, headers: res.headers, text, json, url: res.url, viaProxy: Boolean(usedProxy) }
}

/**
 * 猜这台机器有没有系统代理（Windows 注册表 + 常见环境变量）。
 * 为什么要猜：使用者（包括我自己）没义务知道"插件还得配代理"——
 * 浏览器能打开、插件打不开，这种落差只会被当成插件坏了。
 */
export async function detectProxy() {
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (env && /^https?:\/\//i.test(env)) return env

  if (process.platform !== 'win32') return ''

  return new Promise((resolve) => {
    // 用 reg.exe 而不是 PowerShell：宿主进程里起 PowerShell 慢且可能被策略拦
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    execFile('reg', ['query', key], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) { resolve(''); return }
      const enable = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)
      if (!enable) { resolve(''); return }
      const m = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(stdout)
      if (!m) { resolve(''); return }
      let v = m[1].trim()
      // 注册表可能是 `host:port`，也可能是 `http=host:port;https=host:port`
      if (!/^[a-z]+:\/\//i.test(v)) {
        const perScheme = /https=([^;]+)/i.exec(v) || /http=([^;]+)/i.exec(v)
        v = perScheme ? perScheme[1].trim() : v
        v = 'http://' + v
      }
      // 127.0.0.1:7897 这种必须留着 —— 它就是我们要的
      resolve(v)
    })
  })
}
