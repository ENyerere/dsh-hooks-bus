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
