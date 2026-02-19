# Key 生命周期

本文档描述 FireFrp access key 的完整生命周期，包括状态转换、端口分配与释放、过期清理机制。

## 状态总览

Access key 共有 4 种状态：

| 状态 | 说明 |
|------|------|
| `pending` | 已创建，等待客户端连接激活 |
| `active` | 客户端已连接，隧道运行中 |
| `expired` | 已过期（TTL 到期），隧道已断开 |
| `revoked` | 已撤销（管理员手动操作），隧道已断开 |

## 状态流转图

```
                  QQ Bot "开服"命令
                        │
                        ▼
                  ┌───────────┐
                  │  pending   │  ← 创建 key，分配端口
                  └─────┬─────┘
                        │
              ┌─────────┼──────────┐
              │         │          │
              ▼         │          ▼
    TTL 到期(未使用)    │     管理员撤销
              │         │          │
              ▼         │          ▼
        ┌──────────┐    │    ┌──────────┐
        │ expired  │    │    │ revoked  │
        └──────────┘    │    └──────────┘
                        │
                        ▼
                  frps Login 回调
                  (客户端连接)
                        │
                        ▼
                  ┌───────────┐
                  │  active    │  ← 记录 clientId, activatedAt
                  └─────┬─────┘
                        │
              ┌─────────┼──────────┐
              │                    │
              ▼                    ▼
        TTL 到期              管理员撤销
              │                    │
              ▼                    ▼
        ┌──────────┐         ┌──────────┐
        │ expired  │         │ revoked  │
        └──────────┘         └──────────┘
```

## 状态转换详情

### 1. 创建 (-> pending)

**触发**: QQ Bot 收到 "开服" 命令

**处理流程**:

1. 验证用户限制（每用户最多 3 个同时活跃 key）
2. 验证群限制（每群每小时最多 10 次开服）
3. 从端口池分配一个可用端口
4. 生成 key：`ff-` + 随机字符串
5. 生成 proxyName：`ff-{id}-{gameShort}`（如 `ff-1-mc`）
6. 计算过期时间：`now + TTL`（默认 60 分钟）
7. 写入数据库，状态设为 `pending`
8. 写入审计日志：`key_created`
9. 通过 Bot 返回 key 和服务器地址给用户

**Key 记录初始值**:

```json
{
  "status": "pending",
  "clientId": null,
  "activatedAt": null,
  "remotePort": 10001,
  "expiresAt": "2026-02-19T13:00:00Z"
}
```

### 2. 激活 (pending -> active)

**触发**: frps Login 插件回调（客户端连接 frps 时）

**前置条件**:
- key 状态为 `pending`
- key 未过期（`expiresAt > now`）
- `content.privilege_key` 与 auth token 匹配

**处理流程**:

1. 从 `content.metas.access_key` 提取 key
2. 查询数据库，验证 key 存在且状态为 `pending`
3. 更新状态为 `active`
4. 记录 `clientId` = `content.run_id`
5. 记录 `activatedAt` = `now`
6. 写入审计日志：`key_activated`
7. 返回 `{ "reject": false, "unchange": true }` 允许连接

**注意**: 若 key 状态已为 `active`（重复连接），返回 `KEY_ALREADY_USED` 拒绝。

### 3. 过期 (pending/active -> expired)

**触发**: 过期清理定时任务（每 30 秒执行一次）

**处理流程**:

1. 扫描所有 `pending` 和 `active` 状态的 key
2. 检查 `expiresAt < now`
3. 对过期的 key：
   - 更新状态为 `expired`
   - 释放分配的端口（端口回到可用池）
   - 将 key 加入内存中的 reject set
   - 写入审计日志：`key_expired`
4. reject set 中的 key 会在下一次 frps Ping 回调时导致客户端被断开

**客户端断开流程**:

```
过期清理任务 → key 标记 expired → 加入 reject set
                                        │
frps Ping 回调 ← frps 定期 ping ← 客户端
        │
        ▼
检查 reject set → 找到 → 返回 reject → frps 断开客户端
```

### 4. 撤销 (pending/active -> revoked)

**触发**: 管理员手动操作（未来可通过 Bot 管理命令实现）

**处理流程**:

1. 更新状态为 `revoked`
2. 释放分配的端口
3. 将 key 加入 reject set
4. 写入审计日志：`key_revoked`
5. 客户端会在下一次 Ping 时被断开

## 端口分配与释放

### 端口池

- 范围：`PORT_RANGE_START` ~ `PORT_RANGE_END`（默认 10000 ~ 60000）
- 管理方式：从 access_keys 中所有 `pending` / `active` 状态的记录推导已分配端口
- 不需要单独的端口分配表

### 分配时机

- **分配**: 创建 key 时（`pending` 状态即占用端口）
- **释放**: key 进入 `expired` 或 `revoked` 状态时

### 分配策略

从端口范围内随机选取一个未被占用的端口。已被 `pending` 或 `active` 状态 key 占用的端口不可分配。

## 过期清理机制

### 定时任务 (expiryService)

- **执行间隔**: 每 30 秒
- **扫描范围**: 所有 `pending` 和 `active` 状态且 `expiresAt < now` 的 key

### 清理流程

```
每 30 秒触发
    │
    ▼
扫描过期 key (status in [pending, active] AND expiresAt < now)
    │
    ▼
遍历过期 key:
    ├── 更新状态为 expired
    ├── 释放端口
    ├── 加入 reject set (内存 Set<string>)
    └── 写入审计日志
    │
    ▼
等待 frps Ping 回调:
    ├── 检查 reject set
    ├── 找到 → 返回 reject → frps 断开客户端
    └── 客户端重连时 Login 回调也会拒绝
```

### Reject Set

- **数据结构**: 内存中的 `Set<string>`，存储已过期/已撤销的 key 字符串
- **写入时机**: 过期清理任务标记 key 为 `expired` 或管理员标记 `revoked` 时
- **读取时机**: frps Ping 回调和 Login 回调时
- **清理策略**: reject set 中的条目在对应 key 的 `expiresAt` + 24 小时后移除（避免无限增长）
- **重启恢复**: Server 重启时，从数据库重建 reject set（扫描近 24 小时内过期/撤销的 key）

## 时序图：完整生命周期

```
用户        QQ Bot       Server        frps        Go Client
 │            │            │            │            │
 │─@Bot 开服──▶│            │            │            │
 │            │──创建key───▶│            │            │
 │            │            │─分配端口    │            │
 │            │            │─写入DB      │            │
 │            │◀──返回key──│            │            │
 │◀─key+地址──│            │            │            │
 │            │            │            │            │
 │            │            │            │       用户输入key
 │            │            │            │     + 本地端口
 │            │            │◀──validate──────────────│
 │            │            │──frps连接参数───────────▶│
 │            │            │            │            │
 │            │            │            │◀──Login────│
 │            │            │◀─plugin────│            │
 │            │            │─验证key     │            │
 │            │            │─pending→active           │
 │            │            │──allow────▶│            │
 │            │            │            │──允许连接──▶│
 │            │            │            │            │
 │            │            │            │◀─NewProxy──│
 │            │            │◀─plugin────│            │
 │            │            │─验证proxy   │            │
 │            │            │──allow────▶│            │
 │            │            │            │──代理就绪──▶│
 │            │            │            │            │
 │            │         ┌──────────隧道运行中──────────┐
 │            │         │  (frps 定期 Ping)           │
 │            │         └─────────────────────────────┘
 │            │            │            │            │
 │            │         TTL 到期        │            │
 │            │         过期任务触发     │            │
 │            │            │─标记expired │            │
 │            │            │─释放端口    │            │
 │            │            │─加入reject  │            │
 │            │            │            │            │
 │            │            │            │──Ping─────▶│
 │            │            │◀─plugin────│            │
 │            │            │─检查reject  │            │
 │            │            │──reject───▶│            │
 │            │            │            │──断开连接──▶│
 │            │            │            │            │
```
