# FireFrp Build & Bug Report

## 1. 构建文件列表

| 文件 | 说明 | 状态 |
|------|------|------|
| `client/Makefile` | Go 交叉编译 Makefile，支持 linux/darwin/windows amd64/arm64 | 已创建 |

## 2. 发现的 Bug 列表

### 已修复

| # | 位置 | 严重度 | 描述 | 修复方式 |
|---|------|--------|------|----------|
| 1 | `client/go.mod` | **高** | 缺少所有依赖声明（frp, bubbletea, bubbles, lipgloss, samber/lo），Go 版本过低 | 添加 `require` 块，设置 `go 1.24.0`（frp v0.67.0 要求），列出所有直接依赖 |
| 2 | `client/cmd/firefrp/main.go` | **中** | 缺少 `version` 变量声明，Makefile 的 `-ldflags "-X main.version=$(VERSION)"` 无效 | 添加 `var version = "dev"` 包级变量 |
| 3 | `client/cmd/firefrp/main.go` + `internal/config/config.go` | **低** | 无 `--version` 标志，`version` 变量虽存在但不可用 | 添加 `ShowVersion` 配置字段和 `--version` CLI flag |
| 4 | `server/package.json` | **低** | `nanoid` 依赖已不再使用（`crypto.ts` 已改用 `crypto.randomBytes`），但仍在 dependencies 中 | 移除 `nanoid` 依赖 |
| 5 | `server/src/api/frpsPluginRoutes.ts` | **低** | `accessKeyStore` 导入但从未使用（TypeScript 严格模式下会报错） | 移除未使用的 import |
| 6 | `server/src/services/frpManager.ts` | **中** | TOML 配置生成未转义特殊字符（`"`, `\`, 换行符），若 token/password 含特殊字符会导致 frps.toml 语法错误 | 添加 `escapeToml()` 方法，所有字符串值通过转义后再嵌入 TOML |

### 待修复 / 注意事项

| # | 位置 | 严重度 | 描述 | 说明 |
|---|------|--------|------|------|
| 7 | `client/go.mod` | **中** | 缺少 `go.sum` 文件和间接依赖 | 需要在有 Go 1.24+ 环境下执行 `go mod tidy` 生成完整的 go.sum |
| 8 | `server/src/db/models/portAllocation.ts` | **低** | 死代码 — 文件定义了 `getAllocatedPorts()` 和 `isPortAllocated()` 但无任何文件导入使用 | 端口分配逻辑完全在 `services/portService.ts` 中重复实现；此文件可考虑删除 |
| 9 | `server/src/utils/crypto.ts` | **低** | `secureCompare()` 函数已导出但未被使用 | 可保留作为工具函数备用 |
| 10 | `server/src/api/clientRoutes.ts` | **低** | `setInterval` 定时清理速率限制 Map（每5分钟），进程退出时无法清理此定时器 | 不影响功能（`process.exit(0)` 会强制退出），但在测试场景中可能导致句柄泄漏 |

## 3. 跨模块一致性检查结果

### 3.1 API 契约: Server `/api/v1/validate` <-> Client `ValidateResponse`

| 字段 | Server 返回 (JSON key) | Client 结构体 (JSON tag) | 匹配 |
|------|----------------------|------------------------|------|
| `ok` | `boolean` | `json:"ok"` | OK |
| `data.frps_addr` | `string` | `json:"frps_addr"` | OK |
| `data.frps_port` | `number` | `json:"frps_port"` (int) | OK |
| `data.remote_port` | `number` | `json:"remote_port"` (int) | OK |
| `data.token` | `string` | `json:"token"` | OK |
| `data.proxy_name` | `string` | `json:"proxy_name"` | OK |
| `data.expires_at` | `string` (ISO 8601) | `json:"expires_at"` (string) | OK |
| `error.code` | `string` | `json:"code"` | OK |
| `error.message` | `string` | `json:"message"` | OK |

**结论: 完全匹配。**

### 3.2 frps 连接参数一致性

| 参数 | Server 生成/分配 | Client 使用 | 匹配 |
|------|----------------|------------|------|
| ServerAddr | `config.frps.bindAddr` / `req.hostname` | `data.FrpsAddr` -> `commonCfg.ServerAddr` | OK |
| ServerPort | `config.frps.bindPort` (default 7000) | `data.FrpsPort` -> `commonCfg.ServerPort` | OK |
| Auth Token | `config.frps.authToken` | `data.Token` -> `commonCfg.Auth.Token` | OK |
| Auth Method | frps.toml: `method = "token"` | `commonCfg.Auth.Method = v1.AuthMethodToken` | OK |
| Metadata | frps Login 回调读取 `content.metas.access_key` | `commonCfg.Metadatas = {"access_key": ...}` | OK |
| LoginFailExit | N/A | `commonCfg.LoginFailExit = lo.ToPtr(false)` | OK (允许重连) |

**结论: 完全匹配。**

### 3.3 Key 格式一致性

| 检查项 | Server 端 | Client 端 | 匹配 |
|--------|----------|----------|------|
| Key 前缀 | `config.keyPrefix` (default `ff-`) | Input 验证: `strings.HasPrefix(key, "ff-")` | OK |
| Key 字符集 | `crypto.randomBytes(16).toString('hex')` (0-9a-f) | 无字符集验证 (Server 端 `KEY_PATTERN` 限制为 `[a-zA-Z0-9\-_]+`) | OK |
| Key 长度 | 前缀(3) + 32 hex = 35 字符 | Input `CharLimit = 64` (足够) | OK |

**结论: 完全匹配。**

### 3.4 Proxy Name 一致性

| 检查项 | Server 端 | Client 端 | 匹配 |
|--------|----------|----------|------|
| 生成格式 | `ff-{id}-{gameAbbrev}` (e.g. `ff-1-mine`) | 使用 Server validate 返回的 `proxy_name` | OK |
| NewProxy 验证 | `frpsPluginRoutes.ts` 比较 `proxyName !== record.proxyName` | Client 使用 `data.ProxyName` 作为 `proxyCfg.Name` | OK |
| RemotePort 验证 | `frpsPluginRoutes.ts` 比较 `remotePort !== record.remotePort` | Client 使用 `data.RemotePort` 作为 `proxyCfg.RemotePort` | OK |

**结论: 完全匹配。**

### 3.5 frps 插件协议一致性 (v0.67.0)

| 操作 | frps 发送格式 | Server 处理 | 匹配 |
|------|-------------|------------|------|
| Login | `content.metas.access_key`, `content.run_id` | `handleLogin` 读取 `content.metas`, `content.run_id` | OK |
| NewProxy | `content.user.metas.access_key`, `content.proxy_name`, `content.remote_port` | `handleNewProxy` 读取 `content.user.metas`, `content.proxy_name`, `content.remote_port` | OK |
| Ping | `content.user.metas.access_key` | `handlePing` 读取 `content.user.metas` | OK |
| CloseProxy | `content.user.metas.access_key`, `content.proxy_name` | `handleCloseProxy` 读取 `content.user.metas`, `content.proxy_name` | OK |
| 响应(允许) | 期望 `{"reject": false, "unchange": true}` | `allow()` 返回 `{reject: false, reject_reason: "", unchange: true}` | OK |
| 响应(拒绝) | 期望 `{"reject": true, "reject_reason": "..."}` | `reject(reason)` 返回 `{reject: true, reject_reason: reason}` | OK |

**结论: 完全匹配。frps 插件协议已按 v0.67.0 源码（`pkg/plugin/server/types.go`）正确实现。**

### 3.6 frps TOML 配置一致性 (v0.67.0)

| 配置项 | 生成的 TOML key | frps ServerConfig JSON tag | 匹配 |
|--------|----------------|---------------------------|------|
| `bindAddr` | `bindAddr = "0.0.0.0"` | `json:"bindAddr,omitempty"` | OK |
| `bindPort` | `bindPort = 7000` | `json:"bindPort,omitempty"` | OK |
| `[auth] method` | `method = "token"` | `AuthServerConfig.Method json:"method,omitempty"` | OK |
| `[auth] token` | `token = "..."` | `AuthServerConfig.Token json:"token,omitempty"` | OK |
| `[webServer] addr` | `addr = "127.0.0.1"` | `WebServerConfig.Addr json:"addr,omitempty"` | OK |
| `[webServer] port` | `port = 7500` | `WebServerConfig.Port json:"port,omitempty"` | OK |
| `allowPorts` | `[{start=N, end=M}]` | `types.PortsRange json:"start,omitempty"/"end,omitempty"` | OK |
| `maxPortsPerClient` | `maxPortsPerClient = 1` | `json:"maxPortsPerClient,omitempty"` | OK |
| `[[httpPlugins]]` | `name/addr/path/ops` | `HTTPPluginOptions json:"name"/"addr"/"path"/"ops"` | OK |

**说明**: frp v0.67.0 的配置加载流程为 TOML -> JSON -> struct 反序列化（通过 `go-toml/v2` + `encoding/json`）。TOML key 名需与 JSON tag 匹配，已验证全部匹配。

## 4. 总结

### 代码质量评估

- **Server 端**: 代码结构清晰，类型定义完整，错误处理全面，原子写入实现正确。所有 import 路径均正确。frps 插件协议严格符合 v0.67.0 规范。
- **Client 端**: Go 代码结构合理，TUI 状态机完整（Input -> Connecting -> Running -> Error -> Input），frpc 嵌入配置正确使用了 v0.67.0 API。
- **跨模块**: API 契约完全匹配，frps 连接参数传递链条完整无误。

### 已修复 Bug 数量: 6
### 待关注项数量: 4

### 关键待办
1. 在 Go 1.24+ 环境下运行 `cd client && go mod tidy` 生成完整依赖
2. 在 Node.js 环境下运行 `cd server && npm install` 安装依赖
3. 可选：清理死代码文件 `server/src/db/models/portAllocation.ts`
