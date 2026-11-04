# 实测行为备忘（live probe findings）

> 来源：2026-09 九事件实测（`dsh-hook-probe` 探针 + 真实宿主 headless/web 会话，33 条实时记录，9/9 事件全部验证）。
> 这些是**运行时实测行为**，不是设计承诺；消费者插件设计时必须把这些当作前提。官方运行时升级后本文档需要重新核对。

## A. 无订阅者的事件不计数、不落日志（快速路径）

`dispatcher.ts` 的快速路径：某事件没有订阅者时直接直通，**stats 计数为 0、无日志**。
含义：设置页里"累计触发 0"只代表"没人订阅"，不代表"没发生"。排查"事件到底有没有触发"必须先挂一个订阅者（比如探针）。

## B. `TurnStart.model` 在会话首个回合恒为 `undefined`

`turn/start` 持久化事件早于 `request/header`（model 从后者缓冲），所以第 1 回合拿不到 model，第 2 回合起才有值。按 model 做统计时把 `undefined` 当正常情况处理。

## C. web profile 下 `Error` 会双发

总线同时监听 `agent/error` 与 `api-session/error`；web profile 的 api-session-controller 会把每个 `agent/error` 再 emit 成 `api-session/error`——**同一次错误产生两条 Error 派发**（errorType 分别为错误码与 `'api-session'`）。headless profile 无此 controller，只发一次。
含义：基于 Error 做告警/计数时必须自行去重（建议按 `sessionId + message + 短时间窗`）。

## D. headless 根会话退出时不发 `SessionEnd`

进程退出路径不经过优雅的 agent dispose：一次性 headless 会话只有 `SessionStart`，没有 `SessionEnd`（只有被正常 dispose 的 subagent 才观察到）。web 宿主中关闭会话可正常触发。
含义：需要"会话结束"语义的消费者（如统计结算）不能依赖 headless 根会话的 SessionEnd；采集结果应优先用 `TurnEnd`。

## E. `Compaction` 极少自然发生；失败时只发 start + end

实测 11 个会话日志（含 270 步、8.5 MB 的长会话）0 条自然 compaction——模型 contextWindow 太大。触发途径：GUI `/compact` 命令或真实上下文压力。
另外**失败的压缩只发 `start` + `end`，不发 `summary`**，失败原因在 `CompactionEvent.error`（如 "summary is not smaller than the shadowed content"）。消费 Compaction 时四相位都可能缺 summary。

## F. `UserPromptSubmit` 跳过不含 user 消息的批次

总线显式判断 `messages.some(m => m.role === 'user')`，纯 assistant/tool 的续跑步骤不派发该事件。所以一个回合里 step 数会明显多于 UserPromptSubmit 次数（实测 43 vs 6）。这是**总线的有意设计**，不是遗漏。

## G. 会话 ID 格式不一致

根会话为 `session-<uuid>`，subagent 子会话为裸 `<uuid>`。按 sessionId 过滤/分组时用完整 ID 匹配，不做前缀假设。

## H. `patchReload: "live"` 是失效配置键

DSH 没有 reload 命令，该配置键全盘无实现。profile 改动（装/卸插件）必须**重启宿主**才生效。

## I. Loader 启动后 ≈1.4 s 会对整棵插件树做一次完整重挂载（P0 M0 实测）

启动后约 1.4 秒，Loader 会把 `AgentLoop`/`SessionStore`/`AgentRegistry`/`HooksBusService` 等**每个 fiber 重建一遍**。后果：

- 首次挂载期捕获的服务对象会**变陈旧**（陈旧对象上的方法可能报 `no agent factory registered` 之类错误，尽管服务键仍"存在"）；
- `ctx.timer`/`ctx.effect` 绑定调用方 fiber，fiber inactive 后抛 `cannot create effect on inactive context`——**定时器不能在会被重建的 fiber 上 arm**（第一方 `dsh-schedule` 因此用裸 `setTimeout` + `unref()`）；
- 长期存活的状态（订阅、注册表、通道）必须在每次挂载后重新生效（用 `ctx.effect` 绑生命周期），或延迟到重挂载稳定后再初始化；
- 正面例证：第一方 `dsh-headless` 声明真实 `inject` 依赖并在 `await loader.await()` 之后建会话，可以稳定跑完整回合。

## J. storageDomain 的命名规则只在真实宿主生效（P0 M2 实测）

存储中枢（`dsh-storage-json` 的 `validateDescriptor`，已对照装机源码核实）强制两条规则：

- **域名/表名**必须匹配 `/^[a-z][a-z0-9_]*$/`——**连字符非法**（`invalid unit name 'dsh-scheduler'`）。别跟着包名起域名；
- **per-record 布局的键**就是文件名，必须匹配 `/^[a-zA-Z0-9_-]+$/`——NUL、路径分隔符等一律拒绝（`per-record key … is not path-safe`）。

两条配套教训：

1. **"存储打不开就降级内存"会把致命配置错误伪装成正常运行**：写入"成功"、读取永远为空、零异常日志。dsh-scheduler M1 的"持久化已验证"就是这样成为假验证的；dsh-hooks-bus 自己的域名也曾犯同款错误（v0.2.1 修复）。设计原则：**"没有存储服务"和"存储打不开"是两件不同的事**——前者可降级，后者必须响亮地失败（宁可不工作，不假装工作）。
2. **桩（stub）存储测试永远碰不到真实后端的校验规则**：自写 MemoryDomain 不做命名/键校验。凡是依赖真实后端规则的代码，必须加"断言常量匹配真实规则"的防回归测试，并在真实宿主里至少验证一次。

## K. storageDomain 启动竞态与修复（P7 M1 实测）

### 现象

DSH `0.2.1-rc.5` 下，总线构造时 `ctx.get('storageDomain', false)` 返回 `undefined`；旧实现只查询一次并永久降级内存。之后同一宿主中存储服务正常可用，但日志/暂停始终没有落盘。

### 修复

- 在 `HooksBusService` 同步构造阶段注册 `ctx.inject(['storageDomain'], ...)`，服务出现后 open；
- 公开 `state().persistence`：`mode` 为 memory/persistent，`status` 为 `unavailable` / `initializing` / `ready` / `error`；
- open 失败进入 `error` 并记录错误摘要，不伪装持久化成功；
- 服务移除且没有替代时，在 Loader 稳定后回到 `memory/unavailable`；
- 用运行代号和 child-fiber/父 fiber 双失效标记避免陈旧 open 提交，迟到的 domain 立即关闭；
- open 前产生的内存日志合并去重、排序并写回存储；暂停竞态以本地最新操作为准。

### 验证级别

| 级别 | 证据 |
|---|---|
| 单元测试 | `tests/persistence.test.ts`：晚到服务、无服务、open 失败、暂停竞态、dispose、服务替换、日志合并、失败摘要清除 |
| 真实 Cordis 挂载 | 同一套 Registry/Dispatcher/Service 在生产代码路径上驱动官方 `tools/pre-execute` waterfall |
| 真实宿主进程 | 隔离 `DSH_HOME` 下两次进程：write PID 与 verify PID 均正常退出；构造时 storage 不可见，约 55 ms 后 `persistent/ready`；12 条日志、暂停状态跨 PID 恢复；`dsh_hooks_bus` 下 `logs/*.json` 与 `global.json` 实际存在 |

真实宿主探针不调用模型、不执行工具，结束后无遗留进程。这里不能把单测通过写成“真实宿主已通过”。

## L. 订阅来源是消费者自报（P7 M2 结论）

- `on()` / `declare()` 的 `owner` 全由消费者提供；总线**不读取调用栈**猜测包名，也不验证包身份；UI 使用“声明包（自报）”措辞。
- `handlerRef` 规范化为包内 POSIX 相对路径；绝对路径、盘符、URL、逃出包外的 `..` 统一显示为 `external`，原始路径不进入 API/日志/UI。
- 旧消费者不传 owner 仍工作，状态里 `owner: {}`，UI 显示 unknown。
- 真实 `dsh-hook-guard-demo` 宿主验证中，`state().subscriptions` 可见：
  `packageName=dsh-hook-guard-demo`、`packageVersion=0.1.0`、`handlerRef=hooks/danger-guard.js`；
  该信息仍只是自报排障信息，不是宿主验证。
- 证据分层：M2 探针是真实宿主（隔离 `DSH_HOME`），单元测试覆盖规范化/不泄露/旧消费者；设置页视觉渲染仍是人工项。

## M. before/after 只是批次内顺序（P7 M3 结论）

- 作用域严格限定为**同一次 `declare()`、同一事件**；不是跨包/跨事件/全局 DAG，也不会等待未来注册的 key。
- 无 before/after 的旧批次保持 priority 降序 + 声明顺序；运行时 `on()` 完全不受影响。
- 稳定拓扑排序的 tie-break 为 priority 降序、声明顺序升序；DAG 约束与 priority 冲突时 DAG 获胜。
- keyless 条目可以通过 before/after 约束 keyed 条目；环检测遍历全部节点和边，keyless 节点参与环时同样报错，错误路径中显示为 `#index`。
- 暂停某个节点不会破坏其余节点的传递顺序；拓扑计算包含暂停节点，最后才过滤。
- 验证级别：F3 全部用例由真实 Cordis 挂载 + 真实 `tools/pre-execute` waterfall 的单测覆盖；**没有新增 M3 专属真实宿主进程探针**。因此这里是“真实 Cordis 挂载验证”，不是完整桌面宿主进程验证。
- M1/M2 的真实宿主探针在 M3 后继续通过，用于防持久化和真消费者回归；它们不证明 DAG 在真实仪表盘中的视觉呈现。
