# dns-treehole

拿 DNS 的 TXT 记录当数据库的匿名即焚留言板。跑在 Cloudflare Workers 上。

- **写**：Worker 校验邀请码 → 建 TXT 记录 → Durable Object 设一个到点删除的闹钟
- **读**：浏览器直接走 DoH 问 `1.1.1.1`，不经过 Worker，不消耗任何额度
- **焚**：DO 闹钟精确删除，外加每分钟一次的 cron 兜底对账

同一份数据在命令行里也能读：

```
dig wall.t.example.com TXT +short
```

---

## 架构

```
POST /api/post
  Worker ─ 校验邀请码 / 字节数
         ├→ DO(gate).create()   全站单实例、串行：计数 → 满了挤掉最接近过期的 → 建 TXT 记录
         └→ DO(recordId).schedule(expiresAt)   闹钟，毫秒级

DO.alarm()
  └→ DELETE 该记录（幂等：404 视为成功）
     失败则指数退避重试，最多 6 次

cron * * * * *
  └→ 列出所有 comment 以 RECORD_TAG 开头的记录
     删掉已过期的（每轮上限 SWEEP_BUDGET 条）

GET /
  静态页 → 前端自己发 DoH 查询
```

**为什么要两套删除？** DNS 记录是 Worker 之外的状态。DO 挂了、闹钟丢了、API 连续限流，都没人收尸。cron 对账让系统自愈。

---

## 记录格式

```
tree1;<创建时间戳>;<存活秒数>;<署名>;<正文>
```

单条 TXT 字符串硬上限 **255 字节**。实测预算：

| 署名 | 开销 | 正文可用 | 约合汉字 |
|------|------|----------|----------|
| `anon`（ttl=300） | 26 字节 | 229 字节 | **76 字** |
| 长中文署名（ttl=86400） | 45 字节 | 210 字节 | 70 字 |

正文里可以带分号和换行，不影响解析（前三段被锚定约束，署名不允许分号）。

**为什么时间戳要写进内容？** 因为 DNS 不保证同一 RRset 内多条记录的返回顺序，客户端必须自己排序。同时 TTL 是缓存时长而非存活时长，所以剩余寿命也得从内容里算。

---

## 部署

### 1. 准备域名

**强烈建议单开一个域名**，别和正经业务共用 zone —— API 令牌能改整个 zone 的记录，包括 A 和 MX。

把域名接进 Cloudflare，记下 Zone ID（域名概览页右下角）。

### 2. 建 API 令牌

Dashboard → My Profile → API Tokens → Create Token → **Edit zone DNS** 模板：

- Permissions：`Zone` / `DNS` / `Edit`
- Zone Resources：**只选这一个 zone**，不要选 All zones

### 3. 改配置

编辑 `wrangler.jsonc` 里的 `vars`：

```jsonc
"BASE_NAME": "t.yourdomain.com",   // 所有帖子挂在这个名字下
"RECORD_CAP": "180"                // 见下方「记录数上限」
```

另外在 zone 里加一条通配 TXT 记录，让还没有帖子的频道返回 NOERROR 而不是 NXDOMAIN：

```
*.t.yourdomain.com   TXT   "tree0"   TTL 60
```

不加的话，解析器会按 SOA 的 minimum（Cloudflare 默认 1800 秒）把 NXDOMAIN 负缓存 30 分钟，空频道里的第一条帖子要等很久才能被看到。前端会自动过滤掉 `tree0`。这条记录的 comment 不要以 `RECORD_TAG` 开头，否则会被对账 cron 当成帖子处理。

### 4. 写入机密

```bash
npx wrangler secret put CF_API_TOKEN     # 第 2 步的令牌
npx wrangler secret put CF_ZONE_ID       # Zone ID
npx wrangler secret put INVITE_CODES     # 逗号分隔的静态码，不限量，如 alice-x9,bob-k2
npx wrangler secret put ADMIN_KEY        # 管理密钥，用来生成有额度的邀请码（见下方「邀请码额度」）
```

### 5. 部署

```bash
npm i -D wrangler
npx wrangler deploy
```

想挂自己的域名：在 `wrangler.jsonc` 里加一条 `routes`，deploy 时 Cloudflare 会自动建 DNS 记录和证书。用 zone 下一级的名字（`x.yourdomain.com`）最稳，Universal SSL 只覆盖一级子域；也别放在 `BASE_NAME` 底下。

```jsonc
"routes": [{ "pattern": "treehole.yourdomain.com", "custom_domain": true }]
```

本地开发（cron 可用 `--test-scheduled` 手动触发）：

```bash
npx wrangler dev
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

---

## 邀请码额度

两种邀请码：

- **静态码**：`INVITE_CODES` secret 里逗号分隔，不限量，适合自己人。
- **生成的码**：有额度（能发几条）和存活时长上限（最长能发多久的帖子，默认 60 秒），用完即止。存在 `PostGate` DO 的 SQLite 里，扣额度和建记录在同一次排队里完成，记录没建成不扣。

生成、查看、作废都走管理接口，用 `ADMIN_KEY` 保护：

```bash
# 生成 3 个各能发 20 条、最长 1 小时的码
# maxTtl 取存活时长选项之一（秒）：60/120/300/600/900/1800/3600/7200/18000/43200/86400，省略即 60
curl -X POST https://<你的域名>/api/admin/invites \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"quota":20,"count":3,"maxTtl":3600,"note":"给同事"}'

# 看所有码的用量（quota / used / left / maxTtl）
curl https://<你的域名>/api/admin/invites -H "Authorization: Bearer $ADMIN_KEY"

# 作废一个
curl -X DELETE https://<你的域名>/api/admin/invites/<code> -H "Authorization: Bearer $ADMIN_KEY"
```

前端没填邀请码时存活时长下拉只列 1、2 分钟；填完邀请码会显示「还剩 N 条」，下拉改为只列这个码允许的档位（静态码列全）；发布后响应里也带 `left` 和 `maxTtl`（静态码为 `null`）。额度用完返回 403「这个邀请码的额度用完了」，存活时长超了返回 400。

---

## 你会撞到的上限

| 限制 | 数值 | 影响 |
|------|------|------|
| 记录数 / zone | **200**（2024-09-01 后新建的免费 zone）<br>1,000（更早的免费 zone）· 3,500（Pro） | 同时存活的帖子总数 |
| API 速率 | 1,200 次 / 5 分钟，按**用户**累计 | 每帖 2 次调用 → 约 600 帖 / 5 分钟 |
| cron 触发器 | 免费版每账号 5 个 | 本项目只用 1 个 |
| cron 精度 | 最细每分钟 | 兜底延迟，主删除靠 DO 闹钟 |
| Durable Objects | 免费版仅 SQLite 存储后端 | 已用 `new_sqlite_classes` |

**关于 200 条**：其他 Cloudflare 服务（如 Email Routing 自动添加的 TXT/MX）也计入配额，所以 `RECORD_CAP` 默认设成 180 留缓冲。算法：`同时存活帖子数 ≈ 发帖速率 × 平均存活时长`。到了 `RECORD_CAP` 不会拒绝发帖，而是把最接近过期的那条提前删掉腾位置（响应里 `evicted: true`）；只有连可删的都没有（或 API 出错）才返回 503。计数、腾位、建记录在全站唯一的 `PostGate` DO 里排队执行，所以并发发帖也不会冲过上限（实测：不串行时 10 个并发会超出 8 条）。查自己 zone 的配额和当前用量：

```bash
curl "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/usage" \
  -H "Authorization: Bearer $CF_API_TOKEN"
# → result.record_quota / result.record_usage
```

**关于 API 额度**：dashboard 上的手工操作吃的是同一份额度。一边调试一边点面板，可能自己把自己限流。

---

## 已知的做不到

- **「阅后即焚」做不到。** 缓存命中的读取不会到达服务器，你收不到「已读」信号；记录一旦进了某个解析器的缓存也撤不回。这里实现的是「定时消失」。
- **无法枚举。** DNS 没有「列出该域下所有名字」的操作。想看某个频道必须知道它的名字 —— 对邀请制来说这是特性，不是缺陷。
- **一屏装不下太多。** 响应超过约 1232 字节会触发截断并回退 TCP，部分家用路由器和企业防火墙会掐掉大 UDP 响应或封 TCP 53。四条满长度的帖子就到顶，再多请分频道。
- **passive DNS 会永久归档。** 有商业机构大规模被动收集全球 DNS 应答。内容一旦被采集，「焚」就失去意义了。**不要放任何真正敏感的东西。**
- **删除有传播延迟。** 最长等于 TTL。设 60 秒就是最坏 60 秒后全网不可见。

---

## 排错

| 现象 | 检查 |
|------|------|
| 发布返回 502 | 令牌权限是否为 `Zone / DNS / Edit`，Zone ID 是否正确 |
| 发布返回 503 | 记录数到上限且没有可挤掉的帖子（正常情况下满了会自动删掉最接近过期的一条）；看 `wrangler tail`，或调高 `RECORD_CAP` |
| 发布成功但读不到 | 等 TTL 秒；或 `dig @1.1.1.1 <name> TXT` 直接确认权威侧 |
| 帖子过期了还在 | 看 `wrangler tail` 里的对账日志；DO 闹钟可能连续失败了 |
| 429 | 五分钟内的 API 调用超了，包括你在 dashboard 上的操作 |

```bash
npx wrangler tail          # 实时日志，能看到每轮对账删了几条
```

---

## 许可

MIT。随便拿去改。
