# API 接口契约文档

本文档定义 FireFrp Server 与 Client 之间的通信接口，以及 frps 插件协议的内部接口。

## 基础信息

- **Server 基地址**: `http://{SERVER_ADDR}:{PORT}`（默认端口 9000）
- **Content-Type**: `application/json`
- **字符编码**: UTF-8

---

## 一、客户端 API

### POST /api/v1/validate

验证 access key，返回 frps 连接参数。客户端凭返回的信息直接连接 frps。

> 注意：validate 不改变 key 状态。真正的激活由 frps Login 插件回调触发。

#### 请求

```http
POST /api/v1/validate HTTP/1.1
Content-Type: application/json

{
  "key": "ff-a1b2c3d4e5f6..."
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | string | 是 | 以 `ff-` 前缀开头的 access key |

#### 成功响应 (200)

```json
{
  "ok": true,
  "data": {
    "frps_addr": "your-server.com",
    "frps_port": 7000,
    "remote_port": 10001,
    "token": "frps-auth-token",
    "proxy_name": "ff-1-mc",
    "expires_at": "2026-02-19T13:00:00Z"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | 固定为 `true` |
| `data.frps_addr` | string | frps 服务器公网地址 |
| `data.frps_port` | number | frps 绑定端口 |
| `data.remote_port` | number | 分配的远程端口 |
| `data.token` | string | frps 认证 token |
| `data.proxy_name` | string | 代理名称，格式 `ff-{id}-{gameShort}` |
| `data.expires_at` | string | Key 过期时间（ISO 8601 格式） |

#### 错误响应 (4xx)

```json
{
  "ok": false,
  "error": {
    "code": "KEY_NOT_FOUND",
    "message": "Access key not found"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | 固定为 `false` |
| `error.code` | string | 错误码（见下表） |
| `error.message` | string | 人类可读的错误描述 |

#### 错误码

| 错误码 | HTTP 状态码 | 说明 |
|--------|-------------|------|
| `KEY_NOT_FOUND` | 404 | access key 不存在 |
| `KEY_EXPIRED` | 410 | access key 已过期 |
| `KEY_ALREADY_USED` | 409 | access key 已被使用（状态为 active） |
| `KEY_REVOKED` | 403 | access key 已被撤销 |

#### 客户端使用流程

1. 用户在 TUI 中输入 key 和本地端口
2. 客户端调用 `POST /api/v1/validate` 验证 key
3. 验证成功后，使用返回的 `frps_addr`、`frps_port`、`token` 构建 frpc 配置
4. 在 frpc 的 `Metadatas` 中附带 `{"access_key": "ff-a1b2c3d4..."}`
5. 启动内嵌 frpc 连接 frps

---

## 二、frps 插件协议（内部）

frps 通过 HTTP Plugin 机制将客户端事件转发到 Node.js Server 进行业务校验。

- **回调地址**: `POST /frps-plugin/handler`
- **调用方**: frps 子进程
- **触发时机**: 客户端 Login、NewProxy、CloseProxy、Ping 事件

### 通用请求格式

```json
{
  "version": "0.1.0",
  "op": "Login",
  "content": {
    // 操作相关的具体内容
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | string | 插件协议版本 |
| `op` | string | 操作类型：`Login` / `NewProxy` / `CloseProxy` / `Ping` |
| `content` | object | 操作相关的内容，结构因 `op` 而异 |

### 通用响应格式

#### 允许

```json
{
  "reject": false,
  "unchange": true
}
```

#### 拒绝

```json
{
  "reject": true,
  "reject_reason": "reason"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `reject` | boolean | 是否拒绝此操作 |
| `unchange` | boolean | 当 `reject=false` 时，是否不修改原始内容 |
| `reject_reason` | string | 当 `reject=true` 时，拒绝原因 |

---

### Login

客户端连接 frps 时触发。Server 通过 `metas.access_key` 验证客户端身份。

#### 请求 content

```json
{
  "version": "0.67.0",
  "hostname": "",
  "os": "linux",
  "arch": "amd64",
  "user": "",
  "timestamp": 0,
  "privilege_key": "frps-auth-token",
  "run_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "pool_count": 1,
  "metas": {
    "access_key": "ff-a1b2c3d4e5f6..."
  },
  "client_address": "1.2.3.4:12345"
}
```

#### 处理逻辑

1. 从 `content.metas.access_key` 提取 key
2. 查询数据库验证 key 存在且状态为 `pending`
3. 验证 `content.privilege_key` 与 auth token 匹配
4. 将 key 状态从 `pending` 更新为 `active`
5. 记录 `content.run_id` 为 `clientId`
6. 记录 `activatedAt` 时间
7. 写入审计日志

#### 响应

- 验证通过：`{ "reject": false, "unchange": true }`
- key 无效/过期/已用：`{ "reject": true, "reject_reason": "invalid access key" }`

---

### NewProxy

客户端注册代理时触发。Server 验证代理配置与 key 记录匹配。

#### 请求 content

```json
{
  "user": {
    "user": "",
    "metas": {
      "access_key": "ff-a1b2c3d4e5f6..."
    },
    "run_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  },
  "proxy_name": "ff-1-mc",
  "proxy_type": "tcp",
  "use_encryption": false,
  "use_compression": false,
  "bandwidth_limit": "",
  "bandwidth_limit_mode": "",
  "group": "",
  "group_key": "",
  "remote_port": 10001
}
```

#### 处理逻辑

1. 通过 `content.user.metas.access_key` 查找 key 记录
2. 验证 `proxy_name` 与记录中的 `proxyName` 匹配
3. 验证 `remote_port` 与记录中的 `remotePort` 匹配
4. 验证 key 状态为 `active`

#### 响应

- 匹配通过：`{ "reject": false, "unchange": true }`
- 不匹配：`{ "reject": true, "reject_reason": "proxy configuration mismatch" }`

---

### Ping

frps 定期 ping 客户端时触发。Server 借此检查 key 是否已过期，实现实时踢出。

#### 请求 content

```json
{
  "user": {
    "user": "",
    "metas": {
      "access_key": "ff-a1b2c3d4e5f6..."
    },
    "run_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  },
  "timestamp": 1708300000,
  "privilege_key": "frps-auth-token"
}
```

#### 处理逻辑

1. 检查内存中的 reject set（由过期清理任务维护）
2. 若 key 在 reject set 中，直接拒绝
3. 否则查询数据库，验证 key 仍为 `active` 且未过期
4. 若已过期，加入 reject set 并拒绝

#### 响应

- key 有效：`{ "reject": false, "unchange": true }`
- key 已过期/已撤销：`{ "reject": true, "reject_reason": "access key expired" }`

---

### CloseProxy

客户端关闭代理时触发。Server 仅记录审计日志。

#### 请求 content

```json
{
  "user": {
    "user": "",
    "metas": {
      "access_key": "ff-a1b2c3d4e5f6..."
    },
    "run_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  },
  "proxy_name": "ff-1-mc",
  "proxy_type": "tcp",
  "remote_port": 10001
}
```

#### 处理逻辑

1. 查找对应的 key 记录
2. 写入审计日志（`proxy_closed` 事件）
3. 不改变 key 状态（key 仍保持 `active`，由过期任务统一清理）

#### 响应

- 始终返回：`{ "reject": false, "unchange": true }`

---

## 三、frps Admin API（内部使用）

Node.js Server 通过 frps 的 webServer API 查询运行状态。

- **基地址**: `http://{FRPS_ADMIN_ADDR}:{FRPS_ADMIN_PORT}`
- **认证**: HTTP Basic Auth（`FRPS_ADMIN_USER` / `FRPS_ADMIN_PASSWORD`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/serverinfo` | 服务器状态信息 |
| GET | `/api/proxy/tcp` | 列出所有 TCP 代理 |
| GET | `/api/proxy/tcp/:name` | 查询指定代理详情 |
| GET | `/api/traffic/:name` | 查询代理流量统计 |

---

## 四、数据结构

### Access Key 记录

```json
{
  "id": 1,
  "key": "ff-a1b2c3d4e5f6...",
  "userId": "qq_openid_xxx",
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
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | number | 自增主键 |
| `key` | string | access key，`ff-` 前缀 + 随机字符串 |
| `userId` | string | QQ 用户 OpenID |
| `userName` | string | QQ 用户昵称 |
| `gameType` | string | 游戏类型，如 `minecraft` |
| `status` | string | 状态：`pending` / `active` / `expired` / `revoked` |
| `remotePort` | number | 分配的远程端口 |
| `proxyName` | string | frps 代理名称，格式 `ff-{id}-{gameShort}` |
| `clientId` | string \| null | frpc 的 run_id，Login 时记录 |
| `createdAt` | string | 创建时间（ISO 8601） |
| `activatedAt` | string \| null | 激活时间（ISO 8601） |
| `expiresAt` | string | 过期时间（ISO 8601） |
| `updatedAt` | string | 最后更新时间（ISO 8601） |

### 审计日志记录

```json
{
  "id": 1,
  "eventType": "key_created",
  "keyId": 1,
  "details": "user=xxx, game=minecraft, port=10001",
  "createdAt": "2026-02-19T12:00:00Z"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | number | 自增主键 |
| `eventType` | string | 事件类型（见下表） |
| `keyId` | number | 关联的 access key ID |
| `details` | string | 事件详情 |
| `createdAt` | string | 事件时间（ISO 8601） |

#### 审计事件类型

| 事件类型 | 说明 |
|----------|------|
| `key_created` | Key 创建（Bot 开服命令触发） |
| `key_activated` | Key 激活（frps Login 回调触发） |
| `key_expired` | Key 过期（过期清理任务触发） |
| `key_revoked` | Key 撤销（管理员操作触发） |
| `proxy_opened` | 代理开启（frps NewProxy 回调触发） |
| `proxy_closed` | 代理关闭（frps CloseProxy 回调触发） |
| `client_rejected` | 客户端被拒绝（frps Ping 回调触发） |
