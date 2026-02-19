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
│  ├── QQ Bot                             │
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
```

## 快速开始

### Server 端

```bash
cd server
cp .env.example .env
# 编辑 .env，至少配置 FRPS_AUTH_TOKEN
npm install
npm run build
npm start
```

Server 启动后会自动完成以下工作：

1. 检测并下载 frps v0.67.0 二进制文件（首次启动）
2. 根据环境变量生成 `frps.toml` 配置
3. 启动 frps 子进程并监控其健康状态
4. 启动 Express API 服务（默认端口 9000）
5. 启动过期清理定时任务
6. 启动 QQ Bot（如已配置）

### Client 端

```bash
cd client
make build          # 编译当前平台
# 或
make build-all      # 交叉编译所有平台
```

运行客户端：

```bash
./firefrp
# TUI 界面中输入 access key 和本地端口即可建立隧道
```

也可以通过命令行参数直接连接：

```bash
./firefrp --server https://your-server.com:9000 --key ff-a1b2c3d4... --port 25565
```

## 环境变量配置

Server 端通过 `.env` 文件或环境变量配置，主要参数如下：

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | `9000` | Express API 监听端口 |
| `FRP_VERSION` | `0.67.0` | frp 版本号 |
| `FRPS_BIND_ADDR` | `0.0.0.0` | frps 绑定地址 |
| `FRPS_BIND_PORT` | `7000` | frps 绑定端口 |
| `FRPS_AUTH_TOKEN` | - | frps 认证 token（必填） |
| `FRPS_ADMIN_ADDR` | `127.0.0.1` | frps 管理面板地址 |
| `FRPS_ADMIN_PORT` | `7500` | frps 管理面板端口 |
| `FRPS_ADMIN_USER` | `admin` | frps 管理面板用户名 |
| `FRPS_ADMIN_PASSWORD` | - | frps 管理面板密码 |
| `PORT_RANGE_START` | `10000` | 端口池起始 |
| `PORT_RANGE_END` | `60000` | 端口池结束 |
| `SERVER_PUBLIC_ADDR` | - | 服务器公网地址（返回给客户端） |
| `KEY_DEFAULT_TTL_MINUTES` | `60` | Key 默认有效时长（分钟） |
| `QQ_BOT_APPID` | - | QQ Bot 应用 ID |
| `QQ_BOT_TOKEN` | - | QQ Bot Token |

## API 概要

### 客户端 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/validate` | 验证 access key，返回 frps 连接参数 |

### frps 插件 API（内部）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/frps-plugin/handler` | 处理 frps 的 Login/NewProxy/Ping/CloseProxy 回调 |

详细接口文档参见 [docs/api-contract.md](docs/api-contract.md)。

## QQ Bot 命令

| 命令 | 示例 | 说明 |
|------|------|------|
| `开服` | `@Bot 开服 Minecraft` / `@Bot 开服 mc 120` | 生成 key + 分配端口，默认 60 分钟 |
| `状态` | `@Bot 状态` | 查看当前用户活跃隧道 |
| `帮助` | `@Bot 帮助` | 显示帮助信息 |

限制：每用户最多 3 个同时活跃 key，每群每小时最多 10 次开服。

## 项目结构

```
FireFrp/
├── server/                  # Server 端 (Node.js/TypeScript)
│   ├── src/
│   │   ├── index.ts         # 入口
│   │   ├── config.ts        # 环境变量配置
│   │   ├── db/              # JSON 存储引擎 + 数据模型
│   │   ├── services/        # 核心业务服务
│   │   ├── api/             # Express 路由
│   │   ├── bot/             # QQ Bot
│   │   ├── middleware/      # 中间件
│   │   └── utils/           # 工具函数
│   └── package.json
├── client/                  # Client 端 (Go)
│   ├── cmd/firefrp/         # 入口
│   ├── internal/
│   │   ├── tui/             # Bubble Tea TUI
│   │   ├── api/             # HTTP 客户端
│   │   ├── tunnel/          # 内嵌 frpc
│   │   └── config/          # 配置
│   ├── go.mod
│   └── Makefile
├── docs/                    # 文档
└── .gitignore
```

## 技术栈

| 组件 | 技术 |
|------|------|
| Server | Node.js 18+ / TypeScript / Express / pino |
| 数据存储 | JSON 文件（原子写入） |
| QQ Bot | QQ 官方 Bot API (REST + WebSocket) |
| 隧道 | frps v0.67.0（由 Node.js 管理的子进程） |
| Client | Go 1.24+ / bubbletea / lipgloss / fatedier/frp v0.67.0 (library) |

## 许可证

请参阅 [LICENSE](LICENSE) 文件。
