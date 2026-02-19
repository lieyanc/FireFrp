# FireFrp 安全审查报告

**审查日期**: 2026-02-19
**审查范围**: Server (Node.js/TypeScript) + Client (Go) 全部源代码
**审查人**: Security Agent

---

## 一、问题总览

| 编号 | 严重程度 | 描述 | 状态 |
|------|---------|------|------|
| SEC-001 | Critical | access key 使用 nanoid 生成，非显式 CSPRNG，密钥长度不足 | 已修复 |
| SEC-002 | Critical | /api/v1/validate 端点无速率限制，可被暴力破解 | 已修复 |
| SEC-003 | Critical | frps 插件回调端点无来源验证 | 已修复 |
| SEC-004 | High | errorHandler 在非生产环境泄露内部错误详情 | 已修复 |
| SEC-005 | High | errorHandler 日志中记录 req.body（含 access key） | 已修复 |
| SEC-006 | High | JSON 数据文件无文件权限限制 | 已修复 |
| SEC-007 | High | frps.toml 配置文件含敏感信息但无权限保护 | 已修复 |
| SEC-008 | High | handleNewProxy 找不到 access_key 时默认 allow | 已修复 |
| SEC-009 | High | 游戏类型未做严格白名单校验，允许任意字符串 | 已修复 |
| SEC-010 | Medium | keyService.activate() 存在竞态条件风险 | 已修复 |
| SEC-011 | Medium | frps 二进制下载无 checksum 校验 | 未修复（建议） |
| SEC-012 | Medium | validate 成功响应中返回 frps authToken | 未修复（设计权衡） |
| SEC-013 | Medium | 默认配置使用不安全的占位密码且无警告 | 已修复 |
| SEC-014 | Low | portService 使用 Math.random() | 未修复（影响极小） |
| SEC-015 | Low | nanoid 依赖残留（已不使用） | 未修复（建议清理） |
| SEC-016 | Low | Go 客户端 API 请求未使用 HTTPS | 未修复（运行时配置） |

---

## 二、详细问题描述及修复

### SEC-001 [Critical] access key 生成安全性不足

**文件**: `server/src/utils/crypto.ts`

**问题描述**:
原始代码使用 `nanoid(21)` 生成 access key。虽然 nanoid v3 内部确实使用 `crypto.getRandomValues()`，但:
1. 21 字符 x 6 bits/字符 = 126 bits 熵值，对于需要抗暴力破解的 access key 来说偏低
2. 生成的 key 总长度仅 24 字符（含前缀），不满足"至少 32 字符"的安全基线
3. 对外部库的安全依赖应当最小化，Node.js 内置 `crypto` 模块更可靠

**风险评估**: 攻击者可能通过在线暴力破解猜测有效的 access key，尤其是在无速率限制的情况下（参见 SEC-002）。

**修复方案（已实施）**:
- 替换为 `crypto.randomBytes(16).toString('hex')`，生成 32 个十六进制字符（128 bits 熵）
- 总 key 长度 = 前缀 3 + 32 = 35 字符
- 同时添加了 `secureCompare()` 函数，使用 `crypto.timingSafeEqual` 防止时序攻击

```typescript
// 修复后
import * as crypto from 'crypto';
export function generateAccessKey(): string {
  const randomPart = crypto.randomBytes(16).toString('hex');
  return `${config.keyPrefix}${randomPart}`;
}
```

---

### SEC-002 [Critical] /api/v1/validate 端点无速率限制

**文件**: `server/src/api/clientRoutes.ts`

**问题描述**:
`POST /api/v1/validate` 端点没有任何速率限制。攻击者可以高频发送请求尝试暴力破解 access key。即使 key 空间为 128 bits，无速率限制仍然是严重的安全缺陷。

**风险评估**: 在无速率限制的情况下，攻击者可以:
- 进行字典攻击或暴力破解尝试
- 通过大量请求造成拒绝服务（DoS）
- 枚举有效 key 的状态信息

**修复方案（已实施）**:
- 添加基于 IP 的双层速率限制：每分钟 20 次，每小时 100 次
- 超出限制返回 HTTP 429 状态码
- 定期清理过期的速率限制桶（每 5 分钟）
- 添加 key 格式验证（最大长度 128，仅允许 `a-zA-Z0-9-_`）

---

### SEC-003 [Critical] frps 插件回调端点无来源验证

**文件**: `server/src/api/frpsPluginRoutes.ts`

**问题描述**:
`POST /frps-plugin/handler` 端点接受来自任何 IP 的请求。由于 frps 作为本地子进程运行，插件回调应该只来自 loopback 地址。恶意攻击者可以伪造 frps 的 Login/NewProxy/Ping 回调，绕过认证直接激活 key。

**风险评估**: 攻击者可以:
- 伪造 Login 回调激活任意 pending key
- 伪造 NewProxy 回调创建未授权的代理
- 伪造 Ping 回调干扰过期检测

**修复方案（已实施）**:
- 添加 `isFromFrps()` 函数验证请求 IP 是否为 loopback（127.0.0.1, ::1, ::ffff:127.0.0.1）
- 非 loopback 请求返回 HTTP 403 Forbidden
- 添加 op 和 content 字段的基本验证

```typescript
const ALLOWED_PLUGIN_SOURCES = new Set([
  '127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost',
]);

function isFromFrps(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  const normalizedIp = ip.replace(/^::ffff:/, '');
  return ALLOWED_PLUGIN_SOURCES.has(ip) || ALLOWED_PLUGIN_SOURCES.has(normalizedIp);
}
```

---

### SEC-004 / SEC-005 [High] errorHandler 信息泄露

**文件**: `server/src/middleware/errorHandler.ts`

**问题描述**:
1. 非生产环境下，错误响应中包含 `err.message`，可能泄露文件路径、数据库查询、内部逻辑等
2. 日志中记录了完整的 `req.body`，而 `/api/v1/validate` 的请求体包含 access key，导致敏感数据被写入日志

**风险评估**: 内部错误信息可帮助攻击者了解系统架构和寻找漏洞利用点。日志中的 access key 可能通过日志收集系统泄露。

**修复方案（已实施）**:
- 所有环境下都返回统一的 "Internal server error" 消息，不泄露内部细节
- 从日志记录中移除 `req.body`，避免记录敏感数据
- 仅在非生产环境的服务端日志中记录 stack trace

---

### SEC-006 / SEC-007 [High] 数据文件和配置文件权限

**文件**: `server/src/db/store.ts`, `server/src/services/frpManager.ts`

**问题描述**:
1. `access_keys.json` 包含 access key 明文，但使用默认文件权限（通常 0644），任何本机用户都能读取
2. `frps.toml` 包含 `auth.token` 和 admin 密码，同样使用默认权限

**风险评估**: 在多用户服务器环境中，其他用户可以读取这些文件获取 access key 或 frps 管理凭据。

**修复方案（已实施）**:
- `store.ts` 的 `save()` 方法使用 `mode: 0o600`（仅 owner 可读写）
- `store.ts` 的 `load()` 方法创建数据目录时使用 `mode: 0o700`
- 加载已有文件时调用 `fs.chmodSync(path, 0o600)` 修正权限
- `frpManager.ts` 写入 `frps.toml` 时使用 `mode: 0o600`

---

### SEC-008 [High] NewProxy 处理中的认证绕过

**文件**: `server/src/api/frpsPluginRoutes.ts`

**问题描述**:
在 `handleNewProxy()` 中，当无法从请求中获取 `access_key` 时，代码默认返回 `allow()`。这意味着如果客户端不在 metas 中设置 access_key，其代理请求会被无条件允许。

**风险评估**: 修改过的 frpc 客户端可以不提供 access_key 直接创建代理，绕过整个认证流程。

**修复方案（已实施）**:
- 将默认行为从 `allow()` 改为 `reject('Missing access_key in user metas')`

---

### SEC-009 [High] 游戏类型无严格白名单

**文件**: `server/src/bot/commands/openServer.ts`

**问题描述**:
原始代码中，如果用户输入的游戏类型不在 `GAME_ALIASES` 中，会直接使用 `rawGameType.toLowerCase()` 作为游戏类型。这允许用户输入任意字符串，可能导致:
- 在审计日志中注入恶意内容
- 在数据文件中存储不受控的数据
- 被用于社会工程（如显示给其他用户的状态信息中）

**修复方案（已实施）**:
- 当输入不在白名单中时，返回错误提示并列出支持的游戏类型
- 移除 fallback 到原始输入的逻辑

---

### SEC-010 [Medium] keyService.activate() 竞态条件

**文件**: `server/src/services/keyService.ts`

**问题描述**:
`activate()` 函数先通过 `findBy('key', key)` 查找记录并检查状态，然后再调用 `update()` 修改状态。虽然 Node.js 是单线程的，但如果在两次同步操作之间有 I/O 操作（如日志写入触发异步操作），理论上可能有两个请求同时通过状态检查。

**风险评估**: 低概率但可能导致同一个 key 被两个不同的客户端同时激活。

**修复方案（已实施）**:
- 在 `update()` 前添加二次 `findById()` 检查，验证状态未在两次调用之间改变
- 添加日志记录以检测竞态条件发生

---

### SEC-011 [Medium] frps 二进制下载无完整性校验

**文件**: `server/src/services/frpManager.ts`

**问题描述**:
`downloadBinary()` 从 GitHub Releases 下载 frps 二进制文件，但没有验证下载文件的 SHA256 checksum。如果发生中间人攻击或 CDN 劫持，可能下载到被篡改的二进制。

**风险评估**: 被篡改的 frps 二进制可能包含后门，完全控制服务器。虽然 HTTPS 提供了传输层保护，但不能防止所有攻击向量。

**建议修复方案（未实施）**:
```typescript
// 在 config.ts 或单独的 checksums 文件中维护已知的 SHA256 值
const KNOWN_CHECKSUMS: Record<string, string> = {
  'frp_0.67.0_linux_amd64.tar.gz': 'sha256:...',
  'frp_0.67.0_darwin_arm64.tar.gz': 'sha256:...',
  // ...
};

// 在 downloadBinary() 中添加:
const hash = crypto.createHash('sha256').update(buffer).digest('hex');
const expected = KNOWN_CHECKSUMS[fileName];
if (expected && hash !== expected.replace('sha256:', '')) {
  throw new Error(`Checksum mismatch for ${fileName}: expected ${expected}, got sha256:${hash}`);
}
```

**不实施原因**: 需要为每个支持的平台维护 checksum 值，且 frp 更新版本时需要同步更新。建议在项目成熟后添加。

---

### SEC-012 [Medium] validate 响应中返回 frps authToken

**文件**: `server/src/api/clientRoutes.ts`

**问题描述**:
`/api/v1/validate` 成功响应中包含 `token: config.frps.authToken`。这个 token 是 frps 的全局认证令牌，泄露后攻击者可以绕过管理系统直接与 frps 通信。

**风险评估**: 如果客户端设备被入侵或网络被嗅探，攻击者获得 authToken 后可以:
- 直接连接 frps 创建不受管理的代理
- 绑定任意端口
- 持久化访问

**建议修复方案（未实施）**:
这是当前架构的设计权衡。frpc 需要 authToken 才能连接 frps。可能的改进方案:
1. 使用 OIDC 认证方式替代 token 认证（frp v0.67.0 支持）
2. 确保 API 仅通过 HTTPS 提供服务
3. 使用短期 token 并定期轮换

**不实施原因**: 需要改变 frp 的认证架构，超出当前安全加固范围。建议在 Phase 5 中评估。

---

### SEC-013 [Medium] 默认配置使用不安全占位密码

**文件**: `server/src/config.ts`

**问题描述**:
`FRPS_AUTH_TOKEN` 默认值为 `change_me_to_a_random_string`，`FRPS_ADMIN_PASSWORD` 默认值为 `change_me_admin_password`。用户可能忘记修改这些值就部署到生产环境。

**修复方案（已实施）**:
- 在 config 模块底部添加启动时安全检查，当检测到默认不安全值时打印明显的 `[SECURITY WARNING]` 警告

---

### SEC-014 [Low] portService 使用 Math.random()

**文件**: `server/src/services/portService.ts`

**问题描述**:
`allocate()` 使用 `Math.random()` 随机选择端口。`Math.random()` 不是加密安全的随机数生成器。

**风险评估**: 极低。端口分配不是安全敏感操作，可预测的端口号不会带来实质性安全风险。

**建议**: 如需改进，可替换为 `crypto.randomInt(rangeSize)`。

---

### SEC-015 [Low] nanoid 依赖残留

**文件**: `server/package.json`

**问题描述**:
crypto.ts 已改用 Node.js 内置 `crypto` 模块，但 `package.json` 中仍有 `nanoid` 依赖。

**建议**: 运行 `npm uninstall nanoid` 移除不再使用的依赖，减少攻击面。

---

### SEC-016 [Low] Go 客户端未强制 HTTPS

**文件**: `client/internal/config/config.go`

**问题描述**:
客户端默认 ServerURL 为 `http://localhost:9000`，未强制使用 HTTPS。在生产环境中，API 通信（尤其是传输 access key 和 frps token）应使用 HTTPS。

**建议**: 在非 localhost 地址时，警告或拒绝 HTTP 连接。

---

## 三、已应用修复的文件列表

| 文件路径 | 修改内容 |
|---------|---------|
| `server/src/utils/crypto.ts` | 替换 nanoid 为 crypto.randomBytes，添加 secureCompare |
| `server/src/api/clientRoutes.ts` | 添加 IP 速率限制、key 格式验证 |
| `server/src/api/frpsPluginRoutes.ts` | 添加 loopback IP 来源验证、输入验证、修复 NewProxy 默认 allow |
| `server/src/middleware/errorHandler.ts` | 移除 req.body 日志记录、统一错误消息 |
| `server/src/db/store.ts` | 数据文件权限设为 0600，目录权限设为 0700 |
| `server/src/services/frpManager.ts` | frps.toml 文件权限设为 0600 |
| `server/src/services/keyService.ts` | activate() 添加二次状态检查防竞态 |
| `server/src/bot/commands/openServer.ts` | 游戏类型严格白名单校验 |
| `server/src/config.ts` | 添加启动时安全配置警告 |

---

## 四、整体安全评估

### 做得好的方面
1. **原子写入**: JSON 存储使用 write-to-tmp + rename 模式，防止数据损坏
2. **审计日志**: 关键操作（key 创建、激活、过期、撤销、代理关闭）都有审计记录
3. **graceful shutdown**: 进程管理完善，SIGTERM/SIGINT 都有处理
4. **key 状态机**: pending -> active -> expired/revoked 的生命周期管理清晰
5. **指数退避重启**: frps 异常退出后自动重启有退避策略
6. **插件回调安全拒绝**: 错误时默认 reject（而非 allow）
7. **API 响应一致性**: 错误响应使用标准化格式，不泄露内部状态

### 仍需关注的方面
1. **TLS/HTTPS**: 当前无 TLS 配置，生产环境需在反向代理层面添加
2. **密钥轮换**: 无 frps authToken 轮换机制
3. **二进制完整性**: frps 下载未做 checksum 校验
4. **日志敏感数据**: 部分日志可能记录了 key 的前 10 个字符，虽然不完整但仍提供部分信息
5. **内存中的 reject set 无上限**: 长期运行后可能累积大量 key 字符串，需要定期清理

### 安全建议优先级

1. **立即（部署前）**: 确保所有 `.env` 中的密码和 token 已替换为强随机值
2. **短期（Phase 5）**: 添加 HTTPS 支持（或使用 nginx 反向代理）、frps checksum 校验
3. **中期**: 评估 OIDC 认证替代 token 认证、添加 reject set 上限和清理机制
4. **长期**: 考虑将 JSON 文件替换为加密存储、添加 IP 白名单/VPN 访问控制
