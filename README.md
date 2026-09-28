# dsh-hooks-bus

DSH 钩子总线：官方生命周期事件表面之上的**受管理订阅总线**。

官方运行时（`@deepseek-ai/dsh`）已提供强类型的拦截/观察机制（`agent/pre-step`、`tools/pre-execute` 等）。本插件不重新发明拦截，而是提供管理层：

- **版本化事件目录**：友好事件名（`UserPromptSubmit`、`PreToolUse`、…）+ `catalogVersion`（当前 **1.1.0**）
- **双通道订阅**：运行时 API `ctx.hooksBus.on(...)` + 声明式清单（`package.json` 的 `hooksBus.subscriptions`）
- **执行保障**：优先级、每订阅者超时（默认 5s 可配）、错误隔离——订阅者异常**绝不透出到官方链**
- **可观测**：环形缓冲执行日志 + `stats()` 聚合；设置页（Settings → Plugins → Hooks Bus）查看事件目录、订阅者、日志，支持单个停用与全局暂停

## 安装

```sh
# 发布后：
npx dsh plugin install dsh-hooks-bus
# 或（开发/本地）通过 DSH 插件管理器安装本仓库 bundle：
# plugin_manager install_bundle <本仓库绝对路径>
```

安装后在 Settings → Plugins → **Hooks Bus** 页查看总线状态。

## 事件目录（catalog v1.1.0）

| 事件 | 官方机制 | 可拦截 | payload 要点 |
| --- | --- | --- | --- |
| `SessionStart` | `agent/created` | 否 | `{ sessionId, source: startup\|resume\|clear\|compact, workspacePath? }` |
| `SessionEnd` | `agent/disposed` | 否 | `{ sessionId, messageCount, durationMs? }`（messageCount 数持久化 user/message） |
| `UserPromptSubmit` | `agent/pre-step` | ✅ | `{ sessionId, turn, step, text, attachments, messages }`；block=reject，modify=替换消息批 |
| `TurnStart` | `turn/start`（session/event） | 否 | `{ sessionId, turnIndex, model? }`（model 尽力取自 request/header） |
| `PreToolUse` | `tools/pre-execute` | ✅ | `{ sessionId, toolName, args, callId }`；allow/block/cancel/ask（**参数改写官方不支持**） |
| `PostToolUse` | `tools/post-execute` | ✅ | `{ sessionId, toolName, args, result, durationMs?, callId, error? }`；block/modifyValue/modifyContent |
| `TurnEnd` | `agent/turn-stopping` | 否 | `{ sessionId, turnIndex, text?, usage? }` |
| `Compaction` | `compaction/*`（session/event） | 否 | `{ sessionId, phase, turn, compactionId?, shadowedTokenCount?, error?, data }` |
| `Error` | `agent/error` + `api-session/error` | 否 | `{ sessionId?, errorType, message }` |

**为什么没有 `Notification`**：三重证据确认运行时拿不到该事件（实时事件目录无此类事件、官方拦截笔记明确排除、官方 CC 桥不支持列表包含它）。按「不编造 API」原则从 v1 目录移除，README 在此说明。

## 快速上手（消费者插件）

```ts
import type {} from 'dsh-hooks-bus' // 使 ctx.hooksBus 获得类型
import { Context } from 'cordis'

export const inject = ['hooksBus'] // 总线未启用时 Loader 给出明确的服务缺失错误

export function apply(ctx: Context): void {
  const unsubscribe = ctx.hooksBus.on('PreToolUse', (event) => {
    if (event.toolName === 'pwsh' && isDangerous(event.args)) {
      return { action: 'block', reason: '命令被安全策略拦截' }
    }
  }, { priority: 10 })
  ctx.effect(() => unsubscribe)
}
```

完整对接文档（10 分钟上手 + 决策表 + 声明式清单 schema）见 [docs/author-guide.md](docs/author-guide.md)。

## 示例（真实跑通，非 mock）

`docs/examples/` 三个示例订阅者，`tests/examples.test.ts` 在真实 Cordis 挂载上驱动官方事件验证：

- `audit-log.ts` — 审计日志（PostToolUse / TurnEnd / SessionStart）
- `danger-command-guard.ts` — 危险命令拦截（`rm -rf`、`format`、`del /s`、`git push --force` 等）
- `turn-stats.ts` — 回合统计（计数与 token 汇总）

## 设置页

Settings → Plugins → Hooks Bus：

- **事件目录**：每个事件的官方机制、可拦截性、订阅者数、累计触发次数、总耗时
- **订阅者**：按来源（runtime / declarative）与 label 展示，可单独停用/启用
- **执行日志**：按事件 / 订阅者 ID 过滤，显示各订阅者结果与合并决策
- **全局暂停**：一键直通（零开销）；日志默认只存 payload 摘要（200 字符，`logFullPayload` 可开启全文）
- **持久化（v0.2.0）**：执行日志与全局暂停写入插件自己的 storage 域（`storageDomain`，域名 `dsh-hooks-bus`），Host 重启后恢复；存储服务缺失时自动降级为内存模式

## 开发

```sh
pnpm install
pnpm test           # vitest：49 个用例（含真实 Cordis 挂载的接线、示例验证、客户端契约、持久化恢复）
pnpm check:client   # node --check：客户端半边语法门（client/client.js 无 TS 编译覆盖，此脚本兜底）
pnpm build          # tsdown → lib/
pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint（模板配置 + 记录在案的豁免）
```

骨架与构建配置基于 `omdsh-dev/plugin-template`（pnpm + tsdown + vitest + oxlint/oxfmt），未自行发明。

## 里程碑

- [x] M0 探针：可行性报告（《P7-M0-可行性报告》）
- [x] M1 最小核：dispatcher + registry + 5 事件 + 运行时订阅 API + 单元测试
- [x] M2 完整版：9 事件 + 声明式订阅 + 设置页 + 日志查看器 + 三个示例 + README
- [x] M3 生态验证：`dsh-hook-guard-demo` 独立插件（peer 依赖 + 声明式清单），被依赖路径在 profile 中真实激活；日志/暂停持久化落地

## 许可

MIT
