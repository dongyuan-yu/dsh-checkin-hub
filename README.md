# dsh-checkin-hub

把本机上所有能签到的软件收进一个定时器、一个设置页、一个工具。

**装一次，以后每天到点自己签。** 不用开客户端，不用一个个点。

---

## 现在收了哪六家

| id | 名字 | 登录态从哪来 | 备注 |
|---|---|---|---|
| `nano` | Nano 加速器 | `%APPDATA%\test.vpm.pha\nano\shared_preferences.json` | 每次现读，客户端重登会自动跟上 |
| `yabook` | 雅书 | 账号密码（帝国CMS，只能这么来） | 在设置页里填一次 |
| `minimax` | MiniMax Code | `<dataParent>\.minimax\auth\prod\cn\mcode-public\auth.json` | **refresh token 一次性，换完立刻写回** |
| `workbuddy` | WorkBuddy | 借 `dsh-connect-workbuddy` 插件的本机路由 | **多账号：走 `/pool?action=checkin` 签全部** |
| `trae` | TRAE CN | 借 `dsh-connect-trae` 插件的本机路由 | **多账号**；`checkedIn` 与 `didCheckedIn` 是两件事 |
| `doubao` | 豆包 | `<User Data>\Local State` 的 `x-tt-multi-sids` | 不解加密 cookie 库 |

**iKuuu VPN 不做**：面板接口不规范（loader 页 + `POST /auth/login` 回 405）、凭据是 Flutter 侧自加密二进制、`app.so` 里没有 `/user/checkin`。三样凑一起，硬做只能靠模拟点击，不值得。

---

## 装

```bash
git clone https://github.com/dongyuan-yu/dsh-checkin-hub.git
```

然后在 DSH 里（或在会话里让 agent 做）：

```
plugin_manager install_bundle target=file:<你 clone 下来的绝对路径>
```

装完重启 DSH。设置 →「统一签到」就出来了。

前置条件：
- WorkBuddy / TRAE 两家是**借用** `dsh-connect-workbuddy` / `dsh-connect-trae` 这两个插件的本机路由，没装它们那两个卡片会打不开（其余四家不受影响）。
- Node ≥ 22，零第三方依赖。

---

## 用起来

装进 profile 之后：

- **设置页**：设置 →「统一签到」。一屏看完六家今天签没签、连续几天、拿了多少；每家能单独开关、单独签。
- **工具**：`checkin_hub`，参数 `action`（`sign` / `status`）+ `service`（`all` / 某一家）。
- **定时器**：每天到点自动跑，没签上按你设的间隔重试。电脑开着、DSH 在跑就行；错过时间会在 DSH 下次启动 10 秒后补跑。

所有记录写在 `%USERPROFILE%\.dsh\checkin-hub\`（可在设置页改）：`today.json`（今天的账）、`history.log`（一天一行）、`checkin.log`（细节）。配置在同目录 `config.json`，**雅书密码只存这里，不推给 DSH 的 settings**。

`/api/checkin-hub/status` 永远不回完整密码 / token，只回「有没有 + 尾号」。

---

## 几条硬坑（改代码前先看）

1. **MiniMax 的 refresh token 是一次性的。** 刷新成功后必须立刻原子写回文件，否则旧 RT 作废、磁盘上留死凭据、用户要重新登录。`lib/minimax.mjs` 里是先写 `.hub.tmp` 再 `renameSync`。
2. **MiniMax 的 signin 接口认 `authorization: Bearer <AT>` 就够**，实测不需要 `x-signature` / `x-timestamp` / `yy`。网上说必须签名的都是把「token 无效」误诊成「签名失败」。
3. **豆包的 Chromium cookie 库被进程锁死读不了**（`EBUSY` / `JET_errFileAccessDenied`，非管理员无解）。走 `Local State` 的 `saman.local_storage_app_for_web.enterprise` → `x-tt-multi-sids` 才是活路。⚠️ 那个值本身是 JSON 字符串，要**二次 parse**。
4. **豆包的企业号（飞书账号）没有 `daily_signin` 任务**，会回 `710012001 登录已过期`。多个账号时要挨个探测，取第一个有任务的。
5. **WorkBuddy / TRAE 的 loopback 路由**要求 `host` 与 `origin` **同时**指向本机同一个 authority，少一个就 403。
6. 🔴 **DSH 自己的端口每次重启都变。** 别把 `127.0.0.1:xxxxx` 写进代码——那在别人机器上必然错，在自己机器上重启一次就错。正确的取法：**收到 `GET /api/checkin-hub/*` 请求时从 `host` 头学**（浏览器打过来一定带），记进 `<dataDir>\self-base.json`；没环境变量又没请求上下文时再读它兜底。用户手填的 `selfBase` 永远优先。
7. 🔴 **多账号必须走 `/pool?action=checkin`，`/checkin` 只签当前选中的那个。** workbuddy 的 `/checkin` handler 里是 `store.resolve()`（只解析选中账号），**它根本不认 `accountId` 参数**——所以「多个账号里非当前那个也要签到」这件事，单打 `/checkin` 永远做不到。`/pool` 那个 handler 用 `checkinAllAccounts(poolTargets(region), poolRunnerDeps(region))`，逐个 `store.credentialFor(accountId)`（只取凭据、**不切换选择状态**，不会把正在用的流量切到别的账号）。
   - `/pool` 是 **exact 路由 + 只收 POST**，必须带 `action`；池子空回 409 `no-members` / `no-live-members`；不支持签到的地区回 409 `checkin-unsupported`。
   - 返回 `{rows:[{accountId, accountName, status, credit?, streakDays?}]}`，`status` ∈ `claimed | already | failed | skipped`；企业号是 `skipped` + `enterprise accounts have no daily check-in`。
   - ⚠️ **逐账号状态在 `pool.accounts[*].checkedInToday`**，顶层 `checkin.todayCheckedIn` 只反映当前选中账号。两层字段名都不一样（`checkedInToday` vs `todayCheckedIn`），踩过。
8. **Nano 的 API 有 UA 白名单**：必须带 `User-Agent: Dart/3.5 (dart:io)`，否则 200 + 空 body 静默失败。鉴权头是 `Authorization: <token>`，**不加 Bearer**；token 失效回 403 不是 401。
9. **`ctx.get('dshHomePath')` 返回的是函数**，不是字符串。
10. **定时器回调抛异常会带崩宿主进程** ⇒ `tick` 整体包 try-catch。
11. **client bundle 不是 ESM**，是 `window.__ModuleLoader__.load({id, factory})` 自注册脚本。
12. **工具 spec 必须带 `output: {schema, render}`**，只给 name/description/parameters 会被宿主拒。

---

## 开发

```
node --check index.js
node --check client.js
```

改了 `lib/` 或 `index.js` 之后要让 profile 里的拷贝同步：重新 `install_bundle`，或者直接把文件拷进 `C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-checkin-hub\` 再重启 DSH。

零第三方依赖，`engines: node >= 22`。
