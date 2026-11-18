# dsh-session-delete

[English](README.md) · **中文** · 配套规范：[dsh-session-layout](https://github.com/wadwaw7/dsh-session-layout)

给 DeepSeek Harness 补上「真正删除会话」。

官方只有归档：归档后 `~/.dsh/sessions` 里的日志还在，项目里的会话文件夹也一直留着。
本插件一次删除同时处理三处：

1. **会话存储**：`<sessionPersistence.root>/<工作区>/<sessionId>/`
2. **工作区记录**：`workspace.detachSession(id)`，并从 `archivedSessionIds` 摘除
3. **项目会话文件夹**：`<会话 cwd>/<会话目录>/` 下，`.session.json` 同时满足 `provider=dsh`
   与 `thread_id === sessionId` 的那个子目录

匹配只用 `thread_id`，不看标题、不看日期，因此同一工作区里其它会话的文件夹会原样保留；
没有宿主元数据的旧目录、其他 AI 建立的同 ID 目录、联接与符号链接目标，一律不动。

## 它怎么判断该删哪个文件夹

```text
正在删除的会话                     项目工作区
┌────────────────────┐           ┌──────────────────────────────────────────┐
│ id: session-59f0…  │           │ 会话/                                    │
└─────────┬──────────┘           │ ├─ 2026-11-18-1945-网站验收/             │
          │                      │ │  └─ .session.json                      │
          │  thread_id 匹配       │ │     provider: dsh                      │
          ├─────────────────────▶│ │     thread_id: session-59f0…  ✅ 删除    │
          │                      │ ├─ 2026-11-18-2010-另一个任务/           │
          │                      │ │  └─ .session.json                      │
          │                      │ │     thread_id: session-77ab…  ✅ 保留   │
          │                      │ └─ 2026-11-19-手写笔记/                  │
          │                      │    └─（无 .session.json）      ✅ 保留   │
          └──────────────────────┴──────────────────────────────────────────┘
```

## 插件期望的项目结构

```text
<工作区>/
├─ AGENTS.md                        多 AI 共用的工作区规则
├─ 会话/                            会话目录（目录名可配置）
│  └─ 2026-11-18-1945-网站验收/
│     ├─ .session.json              ← 删除时唯一匹配依据
│     ├─ 会话说明.md                 目标 / 决定 / 结果
│     ├─ 归档索引.md                 每份产物的登记表
│     └─ 证据/                       证据、备份、一次性脚本
└─ <工程目录>/                       产品源码、构建产物、正式文档
```

插件从不进入 `<工程目录>/`：只要过程文件留在会话目录里，删会话就碰不到源码。

## 配合 dsh-session-layout 使用，删除更准

[dsh-session-layout](https://github.com/wadwaw7/dsh-session-layout) 技能定义的就是这套排版。
按它来写，删除会更精确也更安全：

| 规范做法 | 删除时的效果 |
| --- | --- |
| 每个会话目录写 `.session.json`，`thread_id` 用真实会话 ID | 精确命中所删会话的那一个目录 |
| 目录名只写 `YYYY-MM-DD-HHMM-主题`，不塞会话 ID | 名字撞车也不会误删，匹配完全走元数据 |
| 不同 AI 写各自的 `provider` | Codex 等同名目录原样保留 |
| 工程源码放工程目录，过程文件才进会话目录 | 删会话不波及源码 |
| 一次性脚本放会话目录，不放工作区根 | 脚本随会话一起清理 |

没有 `.session.json`、或元数据不完整的目录，插件一律保留、不做任何猜测——误删就是挡在这里。
删除前 30 秒自查：

```bash
cat "会话/<目录>/.session.json"                            # 1. 这个目录属于哪个会话
grep -rl '"thread_id": "<会话ID>"' 会话/*/.session.json     # 2. 有没有重复声明
find "会话/<目录>" -type l                                  # 3. 有没有联接（有则拒绝删除）
```

## 能力

| 入口 | 行为 |
| --- | --- |
| 侧栏会话行菜单 → **删除会话** | 二次确认后删除（推荐用法） |
| `/list-sessions` | 列出所有会话：id、标题、归档状态 |
| `/delete-session <sessionId>` | 命令行版删除 |
| `/purge-archived` | 清空所有已归档会话 |

## 安装

### 插件市场（推荐）

设置 → 插件市场 → 搜索 `dsh-session-delete` → 安装 → 重启 DSH。

### 手动

```powershell
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-session-delete" "<本仓库路径>"
```

再在 profile 的 `package.json` 里登记，两处都要写，缺一处插件页就看不到它：

```json
{
  "dependencies": { "dsh-session-delete": "link:<本仓库路径>" },
  "dsh": { "profile": { "bundles": ["…", "dsh-session-delete"] } }
}
```

## 配置

```yaml
- id: session-delete
  name: dsh-session-delete
  config:
    sessionFolders: ["会话"]   # 可选，默认就是 ["会话"]
```

## 安全边界

- 目标会话正在运行、维护中、存在排队输入或关联任务时拒绝删除；正在进行的任务不自动取消。
- 删除前核对加载状态、原生写锁、唯一存储与目录边界（realpath 校验，拒绝联接与符号链接）。
- 先同盘暂存，再解除工作区、归档、置顶引用，最后清理暂存；注册表阶段失败会回滚目录与引用。
- 最终清理失败时返回暂存路径与错误，不伪报成功。

## 实现

- 宿主侧（`lib/index.js`、`lib/lifecycle.js`）：注入
  `commands / sessionPersistence / workspaceRegistry / agents / agentLoop / sessions / connection`，
  提供 `POST /api/session.delete`（body `{ sessionId }`，返回 `{ ok, dirs, local }`）。
  只对本插件生命周期内捕获到的原生 `AgentHandle` 调用 `dispose()`，用于释放写锁。
- 客户端（`client.js`，ModuleLoader 包）：`ctx.slots.inject('sidebar.workspaces.session.menu.item', ...)`，
  `order: 500`，排在官方「归档」之后；成功后刷新页面。

## 兼容性

- 面向 DSH 0.2.x，桌面端与 Web profile 均可。
- 宿主接口全部走注入，不打包 `@deepseek-ai/*` 运行时副本。

## 披露

- 无云端依赖、无数据外发、不存储任何 API key。
- 只做本地读写（会话存储与项目会话目录），删除目标始终由用户显式选择。

## 许可证

MIT
