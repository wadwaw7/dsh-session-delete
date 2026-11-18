# dsh-session-delete

给 DeepSeek Harness 补上「**真正删除会话**」。

官方只有归档：归档后 `~/.dsh/sessions` 里的日志还在，项目里的会话文件夹也还在。本插件一次删除同时处理三处：

1. **会话存储**：`<sessionPersistence.root>/<工作区>/<sessionId>/`
2. **工作区记录**：`workspace.detachSession(id)` + 从 `archivedSessionIds` 摘除
3. **项目内会话文件夹**：`<会话 cwd>/会话/<直接子目录>` 中 `.session.json` 同时满足 `provider=dsh` 与 `thread_id === sessionId` 的目录

按 `thread_id` 精确匹配（不是按标题/日期猜），同一工作区里其它会话的文件夹不会被误删；无宿主元数据的旧目录、其他 AI 同 ID 目录、联接目标一律保留。

![删除入口](https://raw.githubusercontent.com/wadwaw7/dsh-session-delete/main/assets/screenshot.png)

## 能力

| 入口 | 行为 |
| --- | --- |
| 侧栏会话行 `⋯` 菜单 → **删除会话** | 二次确认后删除该会话（推荐用法） |
| `/list-sessions` | 列出所有会话：id、标题、归档状态 |
| `/delete-session <sessionId>` | 命令行版删除 |
| `/purge-archived` | 清空所有已归档会话 |

![菜单](https://raw.githubusercontent.com/wadwaw7/dsh-session-delete/main/assets/menu.png)

## 安装

### 插件市场（推荐）

设置页 → 插件市场 → 搜索 `dsh-session-delete` → 安装 → 重启 DSH。

### 手动

```powershell
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-session-delete" "<本仓库路径>"
# 重启后由 bundle 的 cordis.patch.yml 自动挂载：
# - insert:
#     - id: session-delete
#       name: dsh-session-delete
```

## 配置

```yaml
- id: session-delete
  name: dsh-session-delete
  config:
    sessionFolders: ["会话"]   # 可选，默认就是 ["会话"]
```

## 安全边界

- 目标会话正在运行、维护中、存在排队输入或关联任务 → 拒绝删除，不自动取消正在进行的任务。
- 删除前核对加载状态、原生写锁、唯一存储与目录边界（realpath 校验，拒绝联接/符号链接）。
- 先同盘暂存 → 解除工作区/归档/置顶引用 → 清理暂存；注册表阶段失败会回滚目录与引用。
- 最终清理失败时返回暂存路径与错误，不伪报完整成功。

## 实现

- Host（`lib/index.js`、`lib/lifecycle.js`）：注入 `commands / sessionPersistence / workspaceRegistry / agents / agentLoop / sessions / connection`，提供 `POST /api/session.delete`（body `{ sessionId }`，返回 `{ ok, dirs, local }`）；仅对本插件生命周期内捕获的原生 `AgentHandle` 调用 `dispose()` 释放写锁。
- Client（`client.js`，ModuleLoader 包）：`ctx.slots.inject('sidebar.workspaces.session.menu.item', ...)`，`order: 500`，排在官方「归档」之后，成功后 `location.reload()`。

## 兼容性

- 面向 DSH 0.2.x（desktop / web profile 均可）。
- 宿主接口全部走注入，不打包 `@deepseek-ai/*` 运行时副本。

## 披露

- 无云端依赖、无数据外发、不存储任何 API key。
- 仅在本地读写会话存储与项目会话目录，删除目标由用户显式选择。

## License

MIT
