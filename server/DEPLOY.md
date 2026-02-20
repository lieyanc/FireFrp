# FireFrp Server 部署指南

## 环境要求

- **Node.js** 18 及以上
- **Linux** (推荐) / macOS / Windows
- 一个拥有公网 IP 的服务器
- (可选) 进程管理工具 (systemd / PM2 / 自有管理平台)

## 首次部署

### 1. 下载

从 GitHub Releases 下载最新的 `firefrp-server.tar.gz`:

```bash
# Release 版本
curl -L -o firefrp-server.tar.gz \
  https://github.com/lieyanc/FireFrp/releases/latest/download/firefrp-server.tar.gz

# 或指定版本
curl -L -o firefrp-server.tar.gz \
  https://github.com/lieyanc/FireFrp/releases/download/v1.0.0/firefrp-server.tar.gz
```

### 2. 解压

```bash
mkdir -p /opt/firefrp-server
tar -xzf firefrp-server.tar.gz -C /opt/firefrp-server
cd /opt/firefrp-server
```

### 3. 配置

首次启动时, 若 `config.json` 不存在, 会自动从 `config.example.json` 复制一份. 建议在启动前手动编辑:

```bash
cp config.example.json config.json
vim config.json
```

**必须修改的字段:**

| 字段 | 说明 |
|------|------|
| `frps.authToken` | frps 认证令牌, 改为强随机字符串 |
| `frps.adminPassword` | frps 管理后台密码 |
| `server.publicAddr` | 服务器的公网地址 (域名或 IP) |
| `server.name` | 节点显示名称 |
| `server.id` | 节点唯一 ID |

详细配置见下方 [config.json 字段速查](#configjson-字段速查).

### 4. 启动

```bash
cd /opt/firefrp-server
node dist/index.js
```

## 目录结构

```
firefrp-server/
├── dist/                  # 编译后的 JS 文件 (OTA 更新会替换)
├── node_modules/          # 依赖包 (OTA 更新会替换)
├── bin/                   # frps 二进制文件 (首次启动自动下载)
├── data/                  # 运行时数据 (access keys, 审计日志)
│   ├── access_keys.json
│   └── audit_log.json
├── config.json            # 用户配置 (OTA 更新不会覆盖)
├── config.example.json    # 配置模板 (用于合并新增字段)
├── version.json           # 当前版本信息 (CI 生成)
└── package.json
```

**OTA 更新时保留的目录/文件:** `config.json`, `data/`, `bin/`

**OTA 更新时替换的目录/文件:** `dist/`, `node_modules/`, `package.json`, `version.json`

## 启动参数

```bash
# 正常启动
node dist/index.js

# 手动触发一次 OTA 更新 (检查 GitHub Releases, 下载并替换后退出)
node dist/index.js --update
```

`--update` 模式会检查 GitHub Releases 是否有新版本, 如果有则下载 tarball, 替换文件后以退出码 0 退出.

## 进程管理

服务端在 OTA 更新完成后会正常退出 (exit 0), 进程管理器应在进程退出后自动以相同命令重启.

### systemd 示例

创建 `/etc/systemd/system/firefrp.service`:

```ini
[Unit]
Description=FireFrp Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/firefrp-server
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3
User=firefrp
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

启用并启动:

```bash
sudo systemctl daemon-reload
sudo systemctl enable firefrp
sudo systemctl start firefrp
```

### 通用说明

如果使用其他进程管理方案 (PM2, Docker, 自有管理平台等), 确保:

1. 工作目录设置为服务端根目录 (包含 `config.json` 的目录)
2. 进程退出后自动使用相同命令重启
3. 正确传递信号 (SIGTERM / SIGINT) 以触发优雅关闭

## OTA 更新机制

### 通过 QQ Bot 触发

管理员在群里 @Bot 发送 `更新`:

1. Bot 查询 GitHub Releases 检查是否有新版本
2. 如果有, 下载 `firefrp-server.tar.gz` 到临时目录
3. 解压并替换 `dist/`, `node_modules/`, `package.json`, `version.json`
4. 进程以 exit 0 退出
5. 进程管理器自动重启, 加载新版本

### 手动触发

```bash
cd /opt/firefrp-server
node dist/index.js --update
# 更新完成后进程退出, 由进程管理器重启
```

### 退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 正常退出 (包括 OTA 更新完成) |
| 1 | 致命错误 / 更新失败 |

## 更新通道

服务端支持三种更新通道, 控制 OTA 从哪个类型的 GitHub Release 拉取更新:

| 通道 | 说明 |
|------|------|
| `auto` | 默认值. 根据当前版本字符串自动判断: `dev-*` 前缀 → 检查 pre-release, 否则检查 release |
| `dev` | 始终检查最新的 pre-release (开发版) |
| `stable` | 始终检查最新的 release (稳定版) |

### 切换通道

**方式 1: QQ Bot 命令 (管理员)**

```
@Bot 通道           # 查看当前通道
@Bot 通道 dev       # 切换到 dev 通道
@Bot 通道 stable    # 切换到 stable 通道
@Bot 通道 auto      # 切换回自动检测
```

**方式 2: 编辑 config.json**

```json
{
  "updates": {
    "channel": "stable"
  }
}
```

修改后重启服务端生效.

通道设置同时影响:
- 服务端 OTA 更新时查找的 Release 类型
- 客户端从 `/api/v1/server-info` 获取的 `update_channel`, 客户端据此决定检查 pre-release 还是 release

## config.json 字段速查

```jsonc
{
  // 管理 API 监听端口
  "serverPort": 9000,

  // frps 版本 (首次启动时自动下载对应版本的 frps 二进制)
  "frpVersion": "0.67.0",

  // 节点信息 (客户端发现时展示)
  "server": {
    "id": "node-1",             // 节点唯一标识
    "name": "默认节点",          // 显示名称
    "publicAddr": "example.com", // 公网地址 (域名或 IP)
    "description": "节点描述"    // 节点描述
  },

  // frps 配置
  "frps": {
    "bindAddr": "0.0.0.0",       // frps 监听地址
    "bindPort": 7000,            // frps 监听端口
    "authToken": "...",          // frps 认证令牌 (必须修改)
    "adminAddr": "127.0.0.1",   // frps 管理 API 地址
    "adminPort": 7500,           // frps 管理 API 端口
    "adminUser": "admin",        // frps 管理 API 用户名
    "adminPassword": "..."       // frps 管理 API 密码 (必须修改)
  },

  // 隧道远程端口范围
  "portRangeStart": 10000,
  "portRangeEnd": 60000,

  // Access Key 有效期 (分钟)
  "keyTtlMinutes": 60,

  // Access Key 前缀
  "keyPrefix": "ff-",

  // 更新通道
  "updates": {
    "channel": "auto"  // auto | dev | stable
  },

  // QQ Bot (OneBot 11) 配置
  "bot": {
    "wsUrl": "ws://127.0.0.1:3001",  // NapCatQQ WebSocket 地址
    "token": "",                       // OneBot access token (可选)
    "selfId": 0,                       // Bot QQ 号 (0 = 自动检测)
    "broadcastGroups": [],             // 广播通知群号列表
    "adminUsers": [],                  // 管理员 QQ 号列表
    "allowedGroups": []                // 白名单群号 (空 = 允许所有)
  }
}
```

## 防火墙端口

确保以下端口对外开放:

| 端口 | 协议 | 说明 |
|------|------|------|
| `serverPort` (默认 9000) | TCP | 管理 API, 客户端连接此端口 |
| `frps.bindPort` (默认 7000) | TCP | frps 主端口, frpc 连接 |
| `portRangeStart` ~ `portRangeEnd` | TCP | 隧道远程端口范围 |

`frps.adminPort` (默认 7500) **不需要**对外开放, 仅供本机管理使用.
