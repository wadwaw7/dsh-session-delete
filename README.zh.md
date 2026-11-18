# dsh-session-delete

给 DeepSeek Harness 补上“**真正删除会话**”：官方只有归档，归档后 `~/.dsh/sessions` 里的日志和项目里的会话文件夹都还在。

## 能力

| 入口 | 行为 |
| --- | --- |
| 侧栏会话行 `⋯` 菜单 → **删除会话** | 确认后删除该会话（推荐用法） |
| `/list-sessions` | 列出所有会话：id、标题、归档状态 |
| `/delete-session <sessionId>` | 命令行版删除 |
| `/purge-archived` | 清空所有已归档会话 |

一次删除同时处理三处：

1. **会话存储**：`<sessionPersistence.root>/<工作区>/<sessionId>/`
2. **工作区记录**：`workspace.detachSession(id)` + 从 `archivedSessionIds` 摘除
3. **项目内会话文件夹**：`<会话 cwd>/会话/<直接子目录>` 中 `.session.json` 同时满足 `provider=dsh` 和 `thread_id` 等于该会话 id 的目录

例如会话在 `D:\zhuomian\逆向` 启动，则删除 `D:\zhuomian\逆向\会话\2026-10-22-4399-zmhj网页逆向-dsh-339535b5\`。

按 `thread_id` 精确匹配（不是按标题/日期猜），同一工作区里其它会话的文件夹不会被误删。

## 配置

```yaml
- id: session-delete
  name: dsh-session-delete
  config:
    sessionFolders: ["会话"]   # 可选，默认就是 ["会话"]
```

## 实现

Host（`lib/index.js`）：

- 注入 commands、sessionPersistence、workspaceRegistry、agents、agentLoop、sessions 和 connection。
- `POST /api/session.delete`，body `{ sessionId }`，返回 `{ ok, dirs, local }`
- 目标运行中、维护中、存在排队输入或关联任务时拒绝删除；仅缓存且完全空闲时先通过原生句柄释放写锁

Client（`client.js`，ModuleLoader 包）：

- `ctx.slots.inject('sidebar.workspaces.session.menu.item', ...)`，`order: 500`，排在官方“归档”后面
- `MenuItemButton` + `window.confirm` 二次确认，成功后 `location.reload()`

## 安装

```powershell
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-session-delete" "D:\zhuomian\逆向\dsh-plugins\dsh-session-delete"
# bundle 的 cordis.patch.yml 使用新增条目语法：
- insert:
    - id: session-delete
      name: dsh-session-delete
```

重启 Harness 生效。

## 卸载

删掉 patch 里两行 + `cmd /c rmdir "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-session-delete"`。


## 2026-10-22 本地兼容维护

启动错误来自桌面profile/package.json带UTF-8 BOM；修复只移除了开头3字节，保留原JSON内容。JSON应使用UTF-8无BOM；Windows PowerShell 5.1的Set-Content -Encoding UTF8会写BOM，不能用该写法生成DSH清单。

新增插件须使用insert条目，普通id配置只覆盖已存在的插件。当前bundle已修正，侧栏入口位于会话行“⋯”菜单中的“删除会话”。

日志读取改用宿主原生stat/open/list接口，支持当前session.v4.jsonl.zstd；标题取原生session/title事件。删除前检查加载状态、原生写锁、唯一存储与目录边界。项目目录同时核对provider=dsh和thread_id；无宿主元数据的旧目录、其他AI同ID目录及联接目标会保留。

通过全部预检后，目录先同盘暂存，再解除工作区、归档和置顶引用，最后清理暂存。注册表失败会尝试回滚目录与引用；若最终文件清理失败，会返回暂存路径及错误，不伪报完整成功。已加载但完全空闲的目标会话由原生 AgentHandle.dispose() 释放后再删除，不再要求每次重启；其他会话可继续工作。目标正在运行、维护、排队或有关联任务时仍拒绝删除；缺少原生释放句柄时保持阻断并提示正常重启。

仅使用本对话目录下新建的原生v4临时会话完成删除与失败回滚测试，真实历史没有被当作测试样本删除。


## 2026-10-22 空闲缓存会话维护修订

修复将 agents.get(id) 存在一律视为运行中的过严判断。插件在自己的 effect 生命周期内跟踪原生 factory createAgent/resume 返回的确切 AgentHandle，保持原调用接收者、owner context 和返回值；卸载时还原方法。不直接删除注册表 Map，不手动关闭存储写句柄，也不卸载其他 Agent。

删除期间只隔离目标的 send/runMaintenance 及同 ID 的 create/resume；目标必须处于 native idle phase、无排队输入，且通过 workspace/session-activity 检查。仅通过捕获的原生 handle.dispose() 完成注销及写入收敛，再申请独占写租约和执行原有暂存/回滚流程。运行中任务不自动取消。若删除后续失败，存储回滚后可重新加载目标。

维护范围限定当前 DSH 0.2.1-rc.2；无已知生命周期句柄、非标准 Agent 或正在加载的目标均阻断，不猜测释放。15项既有回归及11项原生生命周期检查通过；仅隔离临时会话实际删除。真实模型回合没有在隔离测试中调用，运行中状态用受控 phase 模拟，另一个会话的持续工作通过原生 maintenance 实测。
