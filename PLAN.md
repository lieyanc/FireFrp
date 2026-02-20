# FireFrp 实施计划

## Context

搭建一套基于 frp 的隧道管理系统，用于让 QQ 群内用户通过 @Bot 获取临时 access key，在本地 Go 客户端 TUI 中输入 key 和本地端口后，自动建立 TCP 隧道映射。采用分层架构：Node.js 全权管理 frps（自动下载、配置生成、进程生命周期），同时负责业务管理（QQ Bot、密钥、端口分配），Go 客户端内嵌 frp client library。

**frp 锁定版本: v0.67.0**

**QQ Bot 接入: NapCatQQ (OneBot 11 协议)**
- NapCatQQ 是基于 NTQQ 的现代化 Bot 协议实现，实现了 OneBot 11 标准
- 通过正向 WebSocket 连接到 NapCat 的 WS 服务端，获取事件推送和调用 API
- 使用 QQ 号 (int64) 作为用户标识，群号 (int64) 作为群标识
- 消息采用 OneBot 11 消息段数组格式

## 架构总览

```
┌──────────────── Server ────────────────┐
│                                         │
│  Node.js (主进程)                       │
│  :9000 Express API                     │
│  │                                      │
│  ├── frps 进程管理器                    │
│  │   ├── 自动下载 frps v0.67.0         │
│  │   ├── 生成 frps.toml               │
│  │   ├── child_process 管理            │
│  │   └── 健康检查 + 自动重启           │
│  │                                      │
│  ├── frps (子进程, TCP隧道)             │
│  │   :7000 bind                        │
│  │   :7500 admin API ◄── frpsService   │
│  │   plugin ──► /frps-plugin/handler   │
│  │                                      │
│  ├── QQ Bot (OneBot 11 / NapCatQQ)     │
│  │   └── WebSocket ──► NapCat :3001    │
│  ├── Key管理 / Port分配                │
│  └── JSON 数据存储                      │
│      data/access_keys.json             │
│      data/audit_log.json               │
└─────────────────────────────────────────┘
           ▲ frp协议        ▲ HTTPS API
           │                │
┌──────── Go Client (单二进制) ──────────┐
│  TUI (bubbletea) → 验证key → 启动frpc  │
└─────────────────────────────────────────┘

┌──────── NapCatQQ (独立部署) ──────────┐
│  NTQQ 协议 ◄──► QQ 服务器              │
│  :3001 WebSocket Server (OneBot 11)    │
│  ◄── FireFrp Server WS 连接            │
└─────────────────────────────────────────┘
```

## Monorepo 目录结构

```
FireFrp/
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── config.example.json
│   └── src/
│       ├── index.ts                 # 入口：启动 frps → Express → Bot → 定时任务
│       ├── config.ts                # JSON 配置 (含 FRP_VERSION=0.67.0)
│       ├── db/
│       │   ├── store.ts             # JSON 存储引擎：原子读写、文件锁
│       │   └── models/
│       │       ├── accessKey.ts     # Key CRUD (基于 store)
│       │       ├── portAllocation.ts
│       │       └── auditLog.ts
│       ├── services/
│       │   ├── keyService.ts        # Key 生成、验证、生命周期
│       │   ├── portService.ts       # 端口池管理
│       │   ├── frpManager.ts        # frps 全生命周期管理 (核心新增)
│       │   ├── frpsService.ts       # frps Admin API 客户端
│       │   └── expiryService.ts     # 定时过期检查 + 清理
│       ├── api/
│       │   ├── router.ts
│       │   ├── clientRoutes.ts      # Go 客户端 API
│       │   └── frpsPluginRoutes.ts  # frps 插件回调
│       ├── bot/
│       │   ├── qqBot.ts             # OneBot 11 WS 客户端 + 事件分发
│       │   ├── messageParser.ts     # 命令解析
│       │   └── commands/
│       │       ├── openServer.ts    # 开服
│       │       ├── status.ts        # 状态
│       │       └── help.ts          # 帮助
│       ├── middleware/
│       │   └── errorHandler.ts
│       └── utils/
│           ├── crypto.ts
│           └── logger.ts
├── client/
│   ├── go.mod
│   ├── Makefile
│   ├── cmd/firefrp/
│   │   └── main.go                  # 入口：CLI flags → TUI 或直连模式
│   └── internal/
│       ├── tui/
│       │   ├── app.go               # Bubble Tea 顶层 Model
│       │   ├── styles.go            # Lipgloss 样式
│       │   └── views/
│       │       ├── input.go         # Key + 本地端口输入
│       │       ├── connecting.go    # 连接中 spinner
│       │       └── running.go       # 隧道运行状态
│       ├── api/
│       │   └── client.go            # 管理 API HTTP 客户端
│       ├── tunnel/
│       │   └── frpc.go              # 内嵌 frpc：构建配置、启动 Service
│       └── config/
│           └── config.go            # CLI flags + 默认值
└── .gitignore
```

## JSON 数据存储

使用 JSON 文件替代 SQLite，便于迁移和人工检查。数据文件存放在 `server/data/` 目录。

### 存储引擎 (`store.ts`)

```typescript
// 泛型 JSON 存储，每个集合一个文件
// 特性：
// - 原子写入（write tmp → rename）防止数据损坏
// - 启动时自动加载到内存，写操作同步刷盘
// - 自增 ID 管理
// - 简单查询方法：findById, findBy, filter, all

interface StoreOptions<T> {
  filePath: string;        // e.g. 'data/access_keys.json'
  defaults?: T[];          // 初始数据
}

class JsonStore<T extends { id: number }> {
  private items: T[];
  private nextId: number;

  load(): void;            // 从文件读取或创建空文件
  save(): void;            // 原子写入: write tmp → rename
  insert(item: Omit<T, 'id'>): T;
  update(id: number, patch: Partial<T>): T | null;
  delete(id: number): boolean;
  findById(id: number): T | undefined;
  findBy(field: keyof T, value: any): T | undefined;
  filter(predicate: (item: T) => boolean): T[];
  all(): T[];
}
```

### 数据结构

**`data/access_keys.json`**:
```json
[
  {
    "id": 1,
    "key": "ff-a1b2c3d4e5f6...",
    "userId": "123456789",
    "userName": "玩家名",
    "gameType": "minecraft",
    "status": "active",
    "remotePort": 10001,
    "proxyName": "ff-1-mc",
    "clientId": "frpc_run_id",
    "createdAt": "2026-02-19T12:00:00Z",
    "activatedAt": "2026-02-19T12:01:00Z",
    "expiresAt": "2026-02-19T13:00:00Z",
    "updatedAt": "2026-02-19T12:01:00Z"
  }
]
```

**`data/audit_log.json`**:
```json
[
  {
    "id": 1,
    "eventType": "key_created",
    "keyId": 1,
    "details": "user=xxx, game=minecraft, port=10001",
    "createdAt": "2026-02-19T12:00:00Z"
  }
]
```

端口分配不再需要单独的表/文件，直接从 access_keys 中 status 为 pending/active 的记录推导已分配端口。

## frps 进程管理器 (`frpManager.ts`)

Server 端全权管理 frps 的下载、配置和运行。

### 职责

```typescript
class FrpManager {
  // ── 下载管理 ──
  // frps 二进制存放在 server/bin/frps (gitignore)
  // 自动检测 OS/Arch，从 GitHub Releases 下载对应版本
  //
  // 下载 URL 格式:
  //   https://github.com/fatedier/frp/releases/download/v{VERSION}/frp_{VERSION}_{OS}_{ARCH}.tar.gz
  //   例: frp_0.67.0_linux_amd64.tar.gz → 解压取 frps 二进制
  //   Windows: frp_0.67.0_windows_amd64.zip

  async ensureBinary(): Promise<string>;
  // 1. 检查 bin/frps 是否存在
  // 2. 若存在，执行 frps --version 验证版本匹配
  // 3. 若不存在或版本不匹配，下载并解压
  // 4. chmod +x (非 Windows)
  // 5. 返回 frps 二进制路径

  // ── 配置生成 ──
  // 根据 config.ts 中的环境变量动态生成 frps.toml
  // 写入 server/data/frps.toml (运行时生成，gitignore)

  generateConfig(): string;
  // 生成 frps.toml 内容，参数来自 config.ts:
  // - FRPS_BIND_ADDR, FRPS_BIND_PORT
  // - FRPS_AUTH_TOKEN
  // - FRPS_ADMIN_ADDR, FRPS_ADMIN_PORT, FRPS_ADMIN_USER, FRPS_ADMIN_PASSWORD
  // - PORT_RANGE_START, PORT_RANGE_END
  // - PLUGIN_CALLBACK_ADDR (Node.js API 地址)

  // ── 进程管理 ──
  private frpsProcess: ChildProcess | null;
  private state: 'stopped' | 'starting' | 'running' | 'error';

  async start(): Promise<void>;
  // 1. ensureBinary()
  // 2. generateConfig() → 写入 data/frps.toml
  // 3. child_process.spawn(frpsPath, ['-c', configPath])
  // 4. pipe stdout/stderr → logger
  // 5. 监听 exit 事件 → 异常退出自动重启 (指数退避, 最大 30s)
  // 6. 等待 admin API 可达确认启动成功

  async stop(): Promise<void>;
  // 1. 发送 SIGTERM
  // 2. 等待退出 (timeout 10s)
  // 3. 若未退出 → SIGKILL

  async restart(): Promise<void>;
  // stop → start

  getStatus(): FrpManagerStatus;
  // 返回: { state, pid, uptime, version, restartCount }
}
```

### frps 配置（运行时生成）

```toml
# 由 FrpManager 自动生成，请勿手动修改
bindAddr = "0.0.0.0"
bindPort = 7000
auth.method = "token"
auth.token = "{从环境变量}"

webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "{从环境变量}"
webServer.password = "{从环境变量}"

allowPorts = [{ start = 10000, end = 60000 }]
maxPortsPerClient = 1

[[httpPlugins]]
name = "firefrp-manager"
addr = "127.0.0.1:9000"
path = "/frps-plugin/handler"
ops = ["Login", "NewProxy", "CloseProxy", "Ping"]
```

### 启动顺序

```
index.ts 启动流程:
1. 加载配置 (config.ts)
2. 初始化 JSON Store (确保 data/ 目录存在)
3. 启动 Express API (含 frps plugin handler)  ← 必须先于 frps
4. FrpManager.start()  ← 下载(如需) → 生成配置 → 启动子进程
5. 等待 frps admin API 可达
6. 启动 expiryService 定时任务
7. 启动 QQ Bot (Phase 4)
8. 注册 graceful shutdown: stop Bot → stop expiry → FrpManager.stop()
```

## 核心 API

### 客户端 API

**`POST /api/v1/validate`** — 验证 access key，返回 frps 连接参数

请求: `{ "key": "ff-a1b2c3d4..." }`
响应: `{ "ok": true, "data": { "frps_addr", "frps_port", "remote_port", "token", "proxy_name", "expires_at" } }`
错误码: `KEY_NOT_FOUND`, `KEY_EXPIRED`, `KEY_ALREADY_USED`, `KEY_REVOKED`

注意：validate 不改变 key 状态，真正的激活由 frps Login 插件回调触发。

### frps 插件 API

**`POST /frps-plugin/handler`** — 处理 frps 的 Login/NewProxy/Ping/CloseProxy 回调

- **Login**: 从 `content.metas.access_key` 验证 key，pending→active，记录 client_id
- **NewProxy**: 验证 proxy_name 和 remote_port 匹配记录
- **Ping**: 检查内存 reject set + 数据状态，过期则 reject 断开客户端
- **CloseProxy**: 审计日志记录

### frps Admin API 客户端 (`frpsService.ts`)

封装 frps webServer 暴露的 REST API:

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/serverinfo` | 服务器状态信息 |
| GET | `/api/proxy/tcp` | 列出所有 TCP 代理 |
| GET | `/api/proxy/tcp/:name` | 查询指定代理详情 |
| GET | `/api/traffic/:name` | 查询代理流量统计 |

## QQ Bot (NapCatQQ / OneBot 11)

### 接入方式

使用 NapCatQQ 作为 QQ 协议端，通过 OneBot 11 标准协议通信。

**连接模式: 正向 WebSocket (Forward WS)**
- NapCat 启动 WS Server（默认 :3001）
- FireFrp Server 作为 WS Client 连接到 `ws://<napcat_host>:<napcat_port>/`
- 单条 WS 连接同时接收事件推送和发送 API 调用
- NapCat 独立部署，负责 QQ 登录和协议处理

### NapCat 配置要求

NapCat 端需要配置 WebSocket Server，在 NapCat WebUI 或配置文件 `onebot11_<QQ号>.json` 中：

```json
{
  "network": {
    "websocketServers": [{
      "enable": true,
      "host": "0.0.0.0",
      "port": 3001,
      "messagePostFormat": "array",
      "token": "your_access_token",
      "heartInterval": 30000,
      "debug": false
    }]
  }
}
```

关键设置:
- `messagePostFormat`: 必须设为 `"array"`，使用消息段数组格式
- `token`: 用于鉴权，FireFrp 连接时需携带相同 token

### OneBot 11 WebSocket 通信协议

**连接认证**:
连接时通过 URL 参数传递 token: `ws://host:port/?access_token=<token>`

**事件推送 (NapCat → FireFrp)**:
NapCat 将 QQ 事件以 JSON 推送到 WS 连接，群消息事件格式:

```json
{
  "time": 1708300000,
  "self_id": 1234567890,
  "post_type": "message",
  "message_type": "group",
  "sub_type": "normal",
  "message_id": 12345,
  "group_id": 987654321,
  "user_id": 123456789,
  "anonymous": null,
  "message": [
    { "type": "at", "data": { "qq": "1234567890" } },
    { "type": "text", "data": { "text": " 开服 mc 120" } }
  ],
  "raw_message": "[CQ:at,qq=1234567890] 开服 mc 120",
  "font": 0,
  "sender": {
    "user_id": 123456789,
    "nickname": "玩家名",
    "card": "群名片",
    "sex": "unknown",
    "age": 0,
    "area": "",
    "level": "",
    "role": "member",
    "title": ""
  }
}
```

**API 调用 (FireFrp → NapCat)**:
通过 WS 发送 JSON 调用 OneBot API，使用 `echo` 字段关联请求/响应:

```json
{
  "action": "send_group_msg",
  "params": {
    "group_id": 987654321,
    "message": [
      { "type": "at", "data": { "qq": "123456789" } },
      { "type": "text", "data": { "text": " 开服成功!\nAccess Key: ff-a1b2c3d4..." } }
    ]
  },
  "echo": "req_001"
}
```

**API 响应**:
```json
{
  "status": "ok",
  "retcode": 0,
  "data": { "message_id": 67890 },
  "echo": "req_001"
}
```

### 消息段格式 (Message Segments)

OneBot 11 消息使用消息段数组:

| 类型 | 用途 | data 字段 |
|------|------|-----------|
| `text` | 纯文本 | `{ "text": "内容" }` |
| `at` | @某人 | `{ "qq": "QQ号" }` 或 `{ "qq": "all" }` |
| `reply` | 回复消息 | `{ "id": "消息ID" }` |
| `image` | 图片 | `{ "file": "URL或路径" }` |

### qqBot.ts 设计 (OneBot 11 WS Client)

```typescript
import WebSocket from 'ws';

class QQBot {
  private ws: WebSocket | null = null;
  private running: boolean = false;
  private echoCounter: number = 0;
  private pendingCalls: Map<string, { resolve, reject, timer }>;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void>;
  // 1. 从 config 读取 bot.wsUrl 和 bot.token
  // 2. 若 wsUrl 为空则跳过启动
  // 3. 构造 WS URL: wsUrl + ?access_token=token
  // 4. new WebSocket(url)
  // 5. ws.on('open') → 标记 connected, log
  // 6. ws.on('message') → parseEvent / matchEchoResponse
  // 7. ws.on('close') → scheduleReconnect (指数退避, 最大 30s)
  // 8. ws.on('error') → log, 不 crash

  async stop(): Promise<void>;
  // 1. running = false
  // 2. 清除 reconnectTimer / heartbeatTimer
  // 3. ws.close()
  // 4. reject all pending calls

  // ── 事件处理 ──
  private handleEvent(data: any): void;
  // 1. if post_type === 'message' && message_type === 'group'
  //    → 检查消息段中是否有 at 本 bot (self_id)
  //    → 提取 at 之后的文本内容
  //    → 构造 BotMessage { userId, userName, groupId, content }
  //    → 调用 processMessage()
  //    → 若有回复 → sendGroupMessage(groupId, userId, reply)
  // 2. if post_type === 'meta_event' && meta_event_type === 'heartbeat'
  //    → 更新心跳时间戳, log.debug
  // 3. if post_type === 'meta_event' && meta_event_type === 'lifecycle'
  //    → log 生命周期事件 (connect/enable)

  // ── API 调用 ──
  private callApi(action: string, params: any): Promise<any>;
  // 1. echoCounter++, echo = `firefrp_${echoCounter}`
  // 2. 创建 Promise, 存入 pendingCalls[echo]
  // 3. ws.send(JSON.stringify({ action, params, echo }))
  // 4. 设置 10s 超时 → reject
  // 5. 收到匹配 echo 的响应 → resolve(data)

  async sendGroupMessage(groupId: number, userId: number, text: string): Promise<void>;
  // callApi('send_group_msg', {
  //   group_id: groupId,
  //   message: [
  //     { type: 'at', data: { qq: String(userId) } },
  //     { type: 'text', data: { text: ' ' + text } }
  //   ]
  // })

  // ── 重连 ──
  private scheduleReconnect(): void;
  // 指数退避: 1s → 2s → 4s → 8s → 16s → 30s (max)
  // 每次重连调用 connect()
}
```

### 消息解析流程

```
WS 收到群消息事件
  → 检查 message[] 是否包含 at 本 bot 的消息段
  → 提取 at 之后的 text 消息段内容，拼接成纯文本
  → parseCommand(text)
  → handleXxx() 获取回复文本
  → sendGroupMessage() 回复到群
```

### 配置变更

**config.json** `bot` 字段:

```json
{
  "bot": {
    "wsUrl": "ws://127.0.0.1:3001",
    "token": "",
    "selfId": 0
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `wsUrl` | string | NapCat WebSocket Server 地址，为空则不启动 Bot |
| `token` | string | NapCat 配置的 access_token，为空则不鉴权 |
| `selfId` | number | Bot 自身 QQ 号，用于判断 @Bot 消息 (首次连接后可自动获取) |

### QQ Bot 命令

| 命令 | 示例 | 说明 |
|------|------|------|
| `开服` | `@Bot 开服 Minecraft` / `@Bot 开服 mc 120` | 生成 key + 分配端口，默认60分钟 |
| `状态` | `@Bot 状态` | 查看当前用户活跃隧道 |
| `帮助` | `@Bot 帮助` | 显示帮助 |

用户标识使用 QQ 号 (user_id)，群标识使用群号 (group_id)。

限制：每用户最多 3 个同时活跃 key，每群每小时最多 10 次开服。

## Key 生命周期

```
create → [pending] → frps Login → [active] → TTL到期 → [expired]
                                           → 手动撤销 → [revoked]
         [pending] → TTL到期(未使用) → [expired]
```

过期执行：
1. 定时任务(30s) 扫描过期 key，标记 expired，释放端口，加入 reject set
2. frps Ping 回调检查 reject set，reject 断开客户端
3. 客户端重连时 Login 回调拒绝过期 key

## Go 客户端核心

**内嵌 frpc** (`internal/tunnel/frpc.go`):
- 构建 `v1.ClientCommonConfig`: ServerAddr, ServerPort, Auth Token, Metadatas: `{"access_key": key}`
- 构建 `v1.TCPProxyConfig`: Name, LocalIP, LocalPort, RemotePort
- `client.NewService(options)` → `service.Run(ctx)`
- context 取消时优雅关闭

**TUI 状态机**: Input → Connecting → Running → (Error → Input)
- 通过 Go channel 接收隧道状态更新 (Connecting/Connected/Reconnecting/Rejected/Error)
- `LoginFailExit = false` 允许自动重连

## 技术栈

| 组件 | 技术 |
|------|------|
| Server | Node.js 18+ / TypeScript / Express / pino |
| 数据存储 | JSON 文件 (原子写入) |
| QQ Bot | NapCatQQ + OneBot 11 协议 (正向 WebSocket) |
| WS 客户端 | ws (npm) |
| 隧道 | frps v0.67.0 (由 Node.js 管理的子进程) |
| Client | Go 1.21+ / bubbletea / lipgloss / fatedier/frp v0.67.0 (library) |

## 实施顺序

### Phase 1: Server 基础
1. 项目骨架: package.json, tsconfig, .gitignore, .env.example
2. config.ts (含 FRP_VERSION, 所有 frps 参数)
3. JSON 存储引擎: store.ts
4. 数据模型: accessKey.ts, portAllocation.ts, auditLog.ts
5. 核心服务: portService → keyService
6. API: clientRoutes + frpsPluginRoutes + router
7. **FrpManager**: ensureBinary + generateConfig + start/stop/restart
8. 入口: index.ts (启动流程: API → frpManager → expiry)

验证: npm start → 自动下载 frps → 启动 → curl validate API → 原版 frpc 连接 → 插件回调

### Phase 2: 过期与生命周期
1. expiryService 定时任务
2. frpsService (frps Admin API 客户端)
3. 审计日志
4. graceful shutdown 流程

验证: 创建 2 分钟 TTL key → 连接 → 等待过期 → 确认客户端被断开

### Phase 3: Go 客户端
1. go.mod + 依赖 (fatedier/frp v0.67.0)
2. api/client.go (HTTP 客户端)
3. tunnel/frpc.go (内嵌 frpc)
4. TUI views: input → connecting → running
5. tui/app.go 状态机
6. cmd/firefrp/main.go 入口
7. Makefile 交叉编译

验证: 编译二进制 → TUI 输入有效 key → 隧道建立 → Minecraft 可连接

### Phase 4: QQ Bot (NapCatQQ / OneBot 11)
1. 添加 ws 依赖: `npm install ws @types/ws`
2. 更新 config.ts: bot 字段改为 `{ wsUrl, token, selfId }`
3. 更新 config.example.json 对应字段
4. 重写 qqBot.ts: OneBot 11 正向 WebSocket 客户端
   - WS 连接 + 鉴权 (access_token URL 参数)
   - 事件分发: 监听群消息事件，检查 @Bot
   - API 调用: send_group_msg (echo 关联请求/响应)
   - 自动重连 (指数退避)
   - 心跳事件处理
5. 更新 messageParser.ts: 适配 OneBot 11 消息段提取
6. 更新 commands: userId 类型从 OpenID 改为 QQ 号 (string 表示)
7. 更新 BotMessage 接口: 适配 OneBot 11 字段
8. 接入 index.ts (现有 start/stop 生命周期不变)

验证: NapCat 运行 + FireFrp 连接 → QQ 群 @Bot 开服 → 获得 key → 客户端连接 → 全链路通

### Phase 5: 完善
1. 错误处理审查
2. 速率限制
3. 结构化日志
4. GitHub Actions CI (Go 交叉编译)
5. .gitignore 完善
