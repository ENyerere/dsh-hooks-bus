# dsh-hooks-bus 插件作者对接指南

> 目标：**没读过《P7 任务书》的开发者，10 分钟内写出第一个订阅插件。**
> 读完本页 + 复制示例代码即可开工。

---

## 1. 这是什么

dsh-hooks-bus（下称"总线"）把 DSH 官方生命周期事件封装成一套**稳定、友好、版本化**的事件目录。你的插件订阅事件即可注入逻辑——审计、拦截、补上下文、统计——不需要自己 hack 任何拦截点。

- 官方运行时已提供强类型拦截表面（`agent/pre-step`、`tools/pre-execute` 等）；总线不做拦截，只做**管理层**：
- 订阅者**优先级、超时（默认 5s）、错误隔离**：一个坏插件抛异常/死循环，绝不会打断事件链或把一次工具调用变成失败结果。
- 所有订阅在设置页可见、可单独停用；总线可全局暂停（事件直通，零开销）。

## 2. 三步接入（运行时 API）

**第 1 步**：声明依赖（你的 `package.json`）：

```json
{ "peerDependencies": { "dsh-hooks-bus": "*" } }
```

你的插件入口声明硬依赖（总线未启用时 Loader 会给出明确的"服务缺失"错误，而不是崩溃）：

```ts
import type {} from 'dsh-hooks-bus' // 使 ctx.hooksBus 获得类型
import { Context } from 'cordis'

export const inject = ['hooksBus']

export function apply(ctx: Context): void {
  // 第 2 步：订阅。返回值是退订函数，用 ctx.effect 绑定生命周期：
  const unsubscribe = ctx.hooksBus.on(
    'PreToolUse',
    async (event) => {
      // event: { sessionId, toolName, args, callId }
      if (isDangerous(event.args)) {
        return { action: 'block', reason: '命令被安全策略拦截' }
      }
    },
    { priority: 100, timeoutMs: 3000, label: 'my-guard' }, // 优先级高者先跑
  )
  ctx.effect(() => unsubscribe)
}
```

**第 3 步**：完成。你的处理函数会在每次事件发生时被调用。

## 3. 事件目录（catalog v1.1.0）

| 事件 | 触发时机 | 可拦截 | 订阅者可返回 |
| --- | --- | --- | --- |
| `SessionStart` | 会话创建/加载 | 否（官方不可阻断启动） | （返回值忽略） |
| `SessionEnd` | 会话关闭 | 否 | （返回值忽略） |
| `UserPromptSubmit` | 用户消息提交前 | ✅ | `allow` / `block{reason}` / `modify{messages}` |
| `TurnStart` | 回合开始 | 否 | （返回值忽略） |
| `PreToolUse` | 工具调用前 | ✅ | `allow` / `block{reason}` / `cancel` / `ask{reason?}` |
| `PostToolUse` | 工具调用后 | ✅ | `allow` / `block{reason}` / `modifyValue{v}` / `modifyContent{c}` |
| `TurnEnd` | 回合结束 | 否 | （返回值忽略） |
| `Compaction` | 上下文压缩 | 否 | （返回值忽略） |
| `Error` | API/运行时错误 | 否 | （返回值忽略） |

要点：

- **block 即阻断**：`PreToolUse` 的 block → 工具不执行，reason 进入模型可见文本；`UserPromptSubmit` 的 block → 该步不发出模型请求；`PostToolUse` 的 block → feedback 反馈给模型。
- **modify 即改写**：prompt 可整批替换消息；post-tool 可替换规范化值或展示内容。⚠️ **`PreToolUse` 不支持改写参数**——官方设计决策，运行时拿不到。
- 返回 `undefined` / `{ action: 'allow' }` = 放行。返回**非法决策对象** → 视为放行并记 warning 日志。
- 多个订阅者冲突：**任一 block 即 block**；`PreToolUse` 折叠顺序 `block > ask > cancel > allow`；modify 取最高优先级。

## 4. 声明式订阅（跨插件约定）

不想写订阅逻辑？把订阅声明放进你插件的 `package.json`，然后用一行代码装载：

```json
{
  "name": "my-plugin",
  "hooksBus": {
    "subscriptions": [
      { "event": "PostToolUse", "priority": -100, "handler": "./hooks/post-tool.js" }
    ]
  }
}
```

```ts
import type {} from 'dsh-hooks-bus'
import { readFileSync } from 'node:fs'

export const inject = ['hooksBus']

export async function apply(ctx: Context): Promise<void> {
  const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  const dispose = await ctx.hooksBus.declare(manifest.hooksBus.subscriptions, {
    // baseUrl + 默认 loader：P7 会按相对路径动态 import 你的 handler 模块
    baseUrl: new URL('.', import.meta.url).href,
  })
  ctx.effect(() => dispose)
}
```

约定 schema（声明式条目）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `event` | string | 事件名；拼错会在加载时报错并列出合法事件名 |
| `handler` | string | 相对 `baseUrl` 的模块路径；模块 default export 为处理函数 |
| `priority` | number? | 默认 0，高者先跑 |
| `timeoutMs` | number? | 默认总线配置（5s） |
| `label` | string? | 设置页展示名（默认包名） |

`declare(entries, options?)` 接受两种形式：`handler` 为**函数**（直接传）；或 `handler` 为**字符串**（需要 `options.baseUrl`，P7 动态 import）。任何一个条目校验失败，整批声明报错，不留半注册状态。

## 5. 执行保障（你无需关心，但可以依赖）

- **异常隔离**：你的处理函数抛异常，总线捕获、记日志、继续后续订阅者，**异常不会穿透到官方链**（穿透会把一次工具调用变成失败结果）。
- **超时**：默认 5s（全局可配，订阅可覆盖）；超时视为失败并跳过。
- **优先级**：同一事件的订阅者按 priority 从高到低执行。
- **无订阅者 = 零开销**：快速路径直接返回。
- **可观测**：每次分发记录事件名、耗时、各订阅者结果与决策；设置页可查看，`ctx.hooksBus.stats()` 可编程读取。

## 6. 性能红线与注意

- 订阅者的耗时会被计入日志（不含在总线的 5ms 红线内，但会影响事件链延迟）。
- 拦截型事件的订阅者请遵守 `signal` 字段（取消信号），长时间工作应响应取消。
- 不要依赖订阅者之间的调用顺序语义（除了优先级）；顺序是稳定排序但不作契约。

## 7. 完整示例

仓库 `docs/examples/` 下有三个可跑通的示例（tests 中真实挂载验证）：

- `audit-log.ts` — 审计日志：记录 PostToolUse / TurnEnd / SessionStart
- `danger-command-guard.ts` — 危险命令拦截：`rm -rf`、`format`、`del /s`、`git push --force` 等直接 block
- `turn-stats.ts` — 回合统计：TurnEnd 计数与 token 汇总

运行方式：任意 DSH 插件中 `import { registerDangerGuard } from 'dsh-hooks-bus/docs-examples'` 不可用（示例未发布），请直接复制文件内容到你的插件。

## 8. 客户端开发须知（设置页 / dsh.client）

写带设置页的插件时，以下三条都是踩过坑换来的（P7 M2 期间实测）：

1. **`inject` 必须声明用到的每个服务**：客户端模块用 `ctx.slots` 就要在模块返回里写 `inject: ['slots', 'locale']`；少声明一个，宿主注入的就是 undefined，报错信息还不指向真因。
2. **注册 webServer 路由要等服务就绪**：在 `ctx.inject(['webServer'], () => { ... })` 回调里注册 API 路由，否则宿主启动顺序靠后时路由 404。
3. **设置页注册不要挂 `immediately`**：设置页按官方做法懒加载（参考官方配套包 `@deepseek-ai/dsh-client-ui-settings-plugin-inventory`）；所有可见文本走 locale 服务（`ctx.locale.register` + `ctx.locale.bind`），注册项带 `locale` 命名空间。

另外两个容易踩的：

- 客户端 JS 没有 TS 编译覆盖，加一个 `node --check client/client.js` 的脚本报错兜底（本仓库的 `check:client` 可直接照抄）；
- 标题栏的开关要绑定"启用"语义（ON = 运行），别绑定内部状态字段（如 `paused`）——绑定反了用户会以为插件没开。

## 9. 运行时实测行为

设计订阅逻辑前必读 [observed-behavior.md](observed-behavior.md)：快速路径不记录无订阅者的事件、web 下 Error 双发须去重、headless 根会话无 SessionEnd、TurnStart 首回合无 model 等 8 条实测前提。
