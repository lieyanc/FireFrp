# FireFrp

基于 [frp](https://github.com/fatedier/frp) v0.67.0 的临时隧道管理系统。

QQ 群用户通过 @Bot 获取临时 access key，在本地 Go 客户端 TUI 中输入 key 和本地端口，即可自动建立 TCP 隧道映射。适用于 Minecraft 等游戏的联机开服场景。

## 架构

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
│  ├── MOTD 自动检测 (MC)                │
│  ├── 自动更新 (GitHub Releases)        │
│  └── JSON 数据存储                      │
│      data/access_keys.json             │
│      data/audit_log.json               │
└─────────────────────────────────────────┘
           ▲ frp协议        ▲ HTTPS API
           │                │
┌──────── Go Client (单二进制) ──────────┐
│  TUI (bubbletea) → 验证key → 启动frpc  │
│  自动更新 + 服务器发现                  │
└─────────────────────────────────────────┘

┌──────── NapCatQQ (独立部署) ──────────┐
│  NTQQ 协议 ◄──► QQ 服务器              │
│  :3001 WebSocket Server (OneBot 11)    │
│  ◄── FireFrp Server WS 连接            │
└─────────────────────────────────────────┘
```

## 快速开始

### Server 端

```bash
cd server
npm install
npm run build
# 编辑 config.json，至少修改 frps.authToken 和 frps.adminPassword
npm start
```

首次启动时，若 `config.json` 不存在，会自动从 `config.example.json` 创建。Server 启动后自动完成以下工作：

1. 加载并合并配置（`config.json` 与 `config.example.json` 对齐）
2. 初始化 JSON Store（确保 `data/` 目录存在）
3. 清理占用端口的残留进程（Linux）
4. 启动 Express API 服务（默认端口 9000）
5. 检测并下载 frps v0.67.0 二进制文件（首次启动），生成 `frps.toml`，启动 frps 子进程
6. 启动过期清理定时任务（30s 间隔）
7. 启动 QQ Bot（如已配置 `bot.wsUrl`）
8. 注册 graceful shutdown（含下线广播通知）
9. 广播上线通知到配置的群
10. 检测更新标记，广播客户端下载链接（更新后首次启动）

也可以通过 `--update` 参数直接执行更新：

```bash
npm start -- --update
```

### Client 端

```bash
cd client
make build          # 编译当前平台
# 或
make build-all      # 交叉编译所有平台 (linux/darwin/windows)
```

运行客户端：

```bash
./firefrp
# TUI 界面中选择服务器节点，输入 access key 和本地端口即可建立隧道
```

也可以通过命令行参数直接连接：

```bash
./firefrp --server http://your-server.com:9000 --key ff-a1b2c3d4... --port 25565
```

#### 客户端命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--server` | `http://localhost:9001` | 管理 API 地址 |
| `--server-list` | `https://static.lieyan.work/...` | 远程服务器列表 JSON URL |
| `--key` | - | Access key |
| `--port` | - | 本地端口 |
| `--local-ip` | `127.0.0.1` | 本地绑定 IP |
| `--version` | - | 打印版本号并退出 |

当 `--key` 和 `--port` 同时提供时进入直连模式（跳过 TUI），直连模式下会自动检查版本并在版本不匹配时强制更新。

## 配置

Server 端使用 `config.json` 进行配置。首次启动自动从 `config.example.json` 创建，后续启动会自动合并新增字段。

```json
{
  "serverPort": 9000,
  "frpVersion": "0.67.0",
  "server": {
    "id": "node-1",
    "name": "默认节点",
    "publicAddr": "example.com",
    "description": "请在 config.json 中配置节点信息"
  },
  "frps": {
    "bindAddr": "0.0.0.0",
    "bindPort": 7000,
    "authToken": "change_me_to_a_random_string",
    "adminAddr": "127.0.0.1",
    "adminPort": 7500,
    "adminUser": "admin",
    "adminPassword": "change_me_admin_password"
  },
  "portRangeStart": 10000,
  "portRangeEnd": 60000,
  "keyTtlMinutes": 60,
  "keyPrefix": "ff-",
  "updates": {
    "channel": "auto",
    "githubToken": ""
  },
  "bot": {
    "wsUrl": "ws://127.0.0.1:3001",
    "token": "",
    "selfId": 0,
    "broadcastGroups": [],
    "adminUsers": [],
    "allowedGroups": []
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `serverPort` | `9000` | Express API 监听端口 |
| `frpVersion` | `0.67.0` | frp 版本号 |
| `server.id` | `node-1` | 节点 ID（用于服务器发现） |
| `server.name` | `默认节点` | 节点显示名称 |
| `server.publicAddr` | - | 服务器公网地址（必填，返回给客户端） |
| `server.description` | - | 节点描述 |
| `frps.bindAddr` | `0.0.0.0` | frps 绑定地址 |
| `frps.bindPort` | `7000` | frps 绑定端口 |
| `frps.authToken` | - | frps 认证 token（必填，请修改默认值） |
| `frps.adminAddr` | `127.0.0.1` | frps 管理面板地址 |
| `frps.adminPort` | `7500` | frps 管理面板端口 |
| `frps.adminUser` | `admin` | frps 管理面板用户名 |
| `frps.adminPassword` | - | frps 管理面板密码（必填，请修改默认值） |
| `portRangeStart` | `10000` | 端口池起始 |
| `portRangeEnd` | `60000` | 端口池结束 |
| `keyTtlMinutes` | `60` | Key 默认有效时长（分钟） |
| `keyPrefix` | `ff-` | Key 前缀 |
| `updates.channel` | `auto` | 更新通道：`auto` / `dev` / `stable` |
| `updates.githubToken` | - | GitHub API Token（提高 API 速率限制） |
| `bot.wsUrl` | `ws://127.0.0.1:3001` | NapCat WebSocket 地址，为空则不启动 Bot |
| `bot.token` | - | NapCat access_token，为空则不鉴权 |
| `bot.selfId` | `0` | Bot QQ 号（可自动获取） |
| `bot.broadcastGroups` | `[]` | 广播通知群号列表（上下线通知） |
| `bot.adminUsers` | `[]` | 管理员 QQ 号列表 |
| `bot.allowedGroups` | `[]` | 允许使用 Bot 的群白名单（空则不限制） |

## API 概要

### 客户端 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/validate` | 验证 access key，返回 frps 连接参数（限速 20次/分钟） |
| GET | `/api/v1/server-info` | 获取节点信息、客户端版本号和更新通道 |
| GET | `/health` | 健康检查 |

### frps 插件 API（内部）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/frps-plugin/handler` | 处理 frps 的 Login/NewProxy/Ping/CloseProxy 回调 |

详细接口文档参见 [docs/api-contract.md](docs/api-contract.md)。

## QQ Bot

### 接入方式

使用 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 作为 QQ 协议端，通过 OneBot 11 标准协议的正向 WebSocket 通信。NapCat 需独立部署，FireFrp Server 作为 WS Client 连接。

### 用户命令

| 命令 | 别名 | 示例 | 说明 |
|------|------|------|------|
| `开服` | `open` | `@Bot 开服 mc 120` | 生成 key + 分配端口，默认 60 分钟 |
| `状态` | `status` | `@Bot 状态` | 查看当前用户活跃隧道 |
| `列表` | `list` | `@Bot 列表` | 查看本群所有隧道（MC 服务器显示 MOTD） |
| `帮助` | `help` | `@Bot 帮助` | 显示帮助信息 |

支持的游戏类型：`mc`/`minecraft`、`terraria`/`tr`、`dst`、`starbound`、`factorio`、`valheim`、`palworld`

限制：每用户最多 3 个同时活跃 key，每群每小时最多 10 次开服，TTL 范围 5-480 分钟。

### 管理员命令

需要将 QQ 号加入 `bot.adminUsers` 配置。

| 命令 | 别名 | 说明 |
|------|------|------|
| `隧道列表` | `tunnels` | 查看所有活跃/待激活隧道 |
| `踢掉 <隧道ID>` | `kick` | 撤销指定隧道 |
| `服务器` | `server` | 查看 frps 服务器详细状态 |
| `群列表` | `groups` | 查看群白名单 |
| `加群 <群号>` | `addgroup` | 添加群到白名单（运行时持久化） |
| `移群 <群号>` | `rmgroup` | 从白名单移除群 |
| `更新` | `update` | 检查并执行服务端更新 |
| `通道 [auto\|dev\|stable]` | `channel` | 查看或切换更新通道 |

### 自动通知

- 隧道连接/断开时通知对应群
- Minecraft 隧道连接后自动检测 MOTD 并通知（多次重试：15s/1m/3m/5m/10m）
- 节点上线/下线广播到 `broadcastGroups`
- 更新完成后广播客户端下载链接到 `allowedGroups`

## 自动更新

### Server 端

- 通过管理员 Bot 命令 `@Bot 更新` 触发
- 支持 `auto`/`dev`/`stable` 三种更新通道
- 从 GitHub Releases 下载，替换 `dist/`、`node_modules/`、`package.json`、`version.json`
- 保留 `config.json`、`data/`、`bin/` 不受影响
- 也可通过 `npm start -- --update` 命令行触发

### Client 端

- 启动时自动检查服务端要求的客户端版本
- release 版本不匹配时强制更新，dev 版本提示更新
- 从 GitHub Releases 下载对应平台二进制文件，原地替换后重启

## 项目结构

```
FireFrp/
├── server/                  # Server 端 (Node.js/TypeScript)
│   ├── src/
│   │   ├── index.ts         # 入口
│   │   ├── config.ts        # JSON 配置管理
│   │   ├── version.ts       # 版本信息 (CI 生成)
│   │   ├── db/              # JSON 存储引擎 + 数据模型
│   │   ├── services/        # 核心业务服务
│   │   │   ├── keyService.ts
│   │   │   ├── portService.ts
│   │   │   ├── frpManager.ts
│   │   │   ├── frpsService.ts
│   │   │   ├── expiryService.ts
│   │   │   ├── updateService.ts
│   │   │   ├── motdCheckService.ts
│   │   │   └── mcPing.ts
│   │   ├── api/             # Express 路由
│   │   ├── bot/             # QQ Bot (OneBot 11 WS Client)
│   │   │   ├── qqBot.ts
│   │   │   ├── messageParser.ts
│   │   │   └── commands/    # 开服/状态/列表/帮助/管理/更新/通道
│   │   ├── middleware/      # 中间件
│   │   └── utils/           # 工具函数
│   ├── config.example.json  # 配置模板
│   └── package.json
├── client/                  # Client 端 (Go)
│   ├── cmd/firefrp/         # 入口
│   ├── internal/
│   │   ├── tui/             # Bubble Tea TUI
│   │   │   └── views/       # 视图 (server_select/input/connecting/running/updating)
│   │   ├── api/             # HTTP 客户端 + 服务器发现
│   │   ├── tunnel/          # 内嵌 frpc
│   │   ├── updater/         # 自动更新
│   │   └── config/          # CLI flags 配置
│   ├── go.mod
│   └── Makefile
├── docs/                    # 文档
│   ├── api-contract.md
│   ├── key-lifecycle.md
│   ├── build-and-bugs.md
│   └── security-audit.md
├── .github/workflows/       # CI
│   ├── dev.yml              # push to master → dev 预发布
│   └── release.yml          # tag v* → stable 发布
└── .gitignore
```

## 技术栈

| 组件 | 技术 |
|------|------|
| Server | Node.js 18+ / TypeScript / Express / pino |
| 数据存储 | JSON 文件（原子写入） |
| QQ Bot | NapCatQQ + OneBot 11 协议（正向 WebSocket，ws 库） |
| 隧道 | frps v0.67.0（由 Node.js 管理的子进程） |
| MC MOTD | Minecraft SLP 协议（纯 TCP 实现） |
| Client | Go 1.24+ / bubbletea / lipgloss / fatedier/frp v0.67.0 (library) |

## 许可证

请参阅 [LICENSE](LICENSE) 文件。
