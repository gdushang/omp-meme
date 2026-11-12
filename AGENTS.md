# Repository Guidelines

## Project Overview

`omp-meme` 是给 [omp](https://omp.sh) 用的表情包扩展：模型通过 `send_meme` 工具挑选本地**静态图片**，插件在助手回复结束后把图片作为独立消息追加到回复下方。提供图库扫描、内置「大肥鱼」图库、ZIP/URL 导入导出、总开关与调试标签。

- 仓库：<https://github.com/gudushang/omp-meme>
- 入口：`src/index.ts`（`package.json#omp.extensions` 指向它）
- 零依赖、零构建：扩展在 omp 进程内由 Bun 直接加载 `.ts`

## Architecture & Data Flow

`src/index.ts` 的默认工厂注册四类内容：

1. `registerMessageRenderer("omp-meme")` — 渲染追加的图片消息。
2. `registerTool("send_meme")` — 模型按 `tag`/`query` 选图（`approval: "read"`、`loadMode: "essential"`）。
3. 事件：`before_agent_start`（注入提示词）、`agent_end`（投递）、`session_start`（应用关闭状态）、`session_shutdown`（清理）。
4. `registerCommand("meme")` — 图库、开关、导入导出命令。

数据流：

```text
用户消息
  → before_agent_start：enabled + 主会话 + send_meme 在活动工具集 → 追加 MEME_SYSTEM_PROMPT
  → 模型调用 send_meme(tag/query)
  → MemeLibrary.pick() → pending.set(sessionId, {path, caption, tag, pack})
  → agent_end：50ms 轮询到会话空闲（最多 300 次 ≈15s）
  → pi.sendMessage({customType:"omp-meme", display:true, details:{path,...}})
  → registerMessageRenderer 按路径读图 → pi-tui Image（终端不支持时降级文本）
```

关键约束：

- 扩展加载期只能注册；`pi.sendMessage`、`pi.getActiveTools` 等运行期动作必须在事件/命令/工具内调用。
- `agent_end` 触发时 `session.isStreaming` 仍为 true（`promptInFlightCount > 0`），必须轮询到空闲再发，否则消息会被 steer 进当前轮。
- `pending` 是 `Map<sessionId, details>`；每个 session 只有一个槽位，同一轮多次 `send_meme` 只有最后一张生效。`session_shutdown` 只删自己的键，`/meme off` 清空全部。
- `/meme send` 直接调用 `sendMemeMessage`，**不写 pending**；可能与工具选中的图同时出现。
- 投递轮询超时（约 15 s）后退化为 `deliverAs: "nextTurn"`，此时消息被隐藏到下一轮；`--print` 或长期忙碌的会话可能看不到。
- 图片字节不写入会话：`details` 只存绝对路径，渲染时读取；`src/image.ts` 维护最多 64 条按 mtime 失效的 base64 缓存。
- 内置图库根由 `new URL("../memes", import.meta.url)` 决定（`src/library.ts`），仓库必须保留 `src/` 与 `memes/` 的相对位置。
- 关闭语义：`/meme off` 不注入提示词、从活动工具中移除 `send_meme`（工具本身仍注册）、清空 pending、`/meme send` 拒绝；`/meme on` 恢复。

## Key Directories

| 路径 | 用途 |
| --- | --- |
| `src/` | 扩展入口与全部逻辑：`index.ts`、`library.ts`、`config.ts`、`renderer.ts`、`image.ts`、`zip.ts` |
| `test/` | `bun:test` 单测，只覆盖 `src/` 中的纯逻辑模块 |
| `memes/dafeiyu-001/` | 内置「大肥鱼」图库：`manifest.json` + `memes/<tag>/*.jpg`（24 张）；`index.db` 是遗留 SQLite，**代码不读取** |
| 项目根 | `package.json`（扩展清单）、`README.md`、`.gitignore`；无 `tsconfig.json`/锁文件/CI |

## Development Commands

```sh
bun test                                  # 全部单测
bun test test/library.test.ts             # 单文件
bun test -t "scans packs"                 # 按用例名过滤

omp -e .                                  # 临时加载（在本仓库根目录）
omp -e . --auto-approve                   # 仅调试时需要：跳过所有工具审批
```

- 没有 build、lint、typecheck 或 `package.json#scripts`；改动后由 omp 重新 import。
- `src/index.ts`、`src/renderer.ts`、`src/image.ts` 无法在仓库内单测（依赖宿主包），改动必须用 `omp -e .` 人工冒烟。
- Windows 上 omp 的 `?mtime` 重载 query 会被 Bun 忽略，改扩展后建议重启会话。

## Code Conventions & Common Patterns

- **风格**：Tab 缩进、双引号、语句末尾不写分号；相对导入必须带 `.ts` 扩展名（Bun 直接执行）。
- **依赖**：只依赖 Node 内置模块（`node:fs`/`path`/`os`/`url`/`zlib`），不引入第三方库。
- **宿主 API**：从 `@oh-my-pi/pi-coding-agent` 与 `@oh-my-pi/pi-tui` 的根导入；仅类型依赖用 `import type`。不要使用深层内部路径（文件移动会让扩展整体加载失败）。
- **命名**：函数/变量 `camelCase`，类型/类 `PascalCase`，常量 `UPPER_SNAKE_CASE`；标识符英文，面用户的文案中文。
- **错误处理**：库函数 `throw new Error("中文原因")`；命令层统一 `try/catch` 后 `ctx.ui.notify(message, "error")`，不让异常冒泡终止会话。
- **异步/定时器**：事件处理器尽量同步返回；后台工作使用 `ctx.setTimeout`/`ctx.setInterval`（原始定时器抛错会终止整个进程），并在 `session_shutdown` 清理。
- **状态**：扩展实例内用闭包变量（`let config`）与按 session 的 `Map`；持久化只写 `<userRoot>/omp-meme.json`（`{enabled, debug, gear}`）。
- **档位**：`gear` 为 `off` / `auto` / `active` / `always`，默认 `auto`；`before_agent_start` 按档位选择 `MEME_GEAR_PROMPTS` 中的一段拼进系统提示。`/meme off` 是全局关闭，与 `gear=off`（仍注入“不主动”规则）不同。
- **图库**：`MemeLibrary` 通过构造函数注入 roots；测试永远传 `[{ dir, bundled: false }]`，不要碰默认 `~/.omp/memes`。
- **导入安全**：ZIP 条目过 `safeEntryName` + `isPathInside`；图片只接受 `.png/.jpg/.jpeg/.webp/.bmp`；URL 导入只接受 ZIP（magic/content-type/后缀任一命中），上限 64 MB、超时 30 s。
- **图库语义**：tag = `memes/` 下第一层目录名；caption = 文件名 stem；keywords = tag + caption 分词 + manifest 的 `tags`/`name`/`description`。`query` 是子串 AND 匹配，不是全词匹配。
- **开关**：`enabled` 默认 true，`debug` 默认 false；`debug` 只控制是否在图片上方绘制 `[表情: 描述 · 分类]`。
- **改动需同步的位置**：
  - 新增图片格式 → `IMAGE_EXTENSIONS`（`library.ts`）、`MIME_BY_EXTENSION`（`image.ts`）、README、测试。
  - 新增情绪别名 → `TAG_ALIASES`、`MEME_SYSTEM_PROMPT`、`send_meme` 描述、README。
  - 新增 `/meme` 子命令 → `MEME_SUBCOMMANDS`、命令 switch、help 文案、`completeMemeArgs`、README。
  - 新增配置项 → `MemeConfig`/默认值/读取语义（`config.ts`）、`/meme` 命令、`test/config.test.ts`。
  - 调整斗图档位 → `MEME_GEAR_PROMPTS`、`MEME_GEARS`、`/meme gear` 补全、README 档位表。

## Important Files

| 文件 | 内容 |
| --- | --- |
| `src/index.ts` | 扩展入口：提示词、工具、事件、`/meme` 命令与补全、投递轮询 |
| `src/library.ts` | 图库扫描、tag/caption/keywords、选图、目录/ZIP/单图/URL 导入、ZIP 导出 |
| `src/config.ts` | `omp-meme.json` 读写、默认值与损坏回退 |
| `src/renderer.ts` | `omp-meme` 消息渲染、debug 标签、28×9 单元格图片 |
| `src/image.ts` | 扩展名 → MIME、base64 缓存 |
| `src/zip.ts` | 自研 ZIP 读写（store/deflate，拒绝 ZIP64/加密） |
| `package.json` | `omp.extensions` / `pi.extensions` → `./src/index.ts` |
| `test/*.test.ts` | `config`、`library`、`zip` 的行为测试 |

## Runtime/Tooling Preferences

- 测试需要本地 Bun ≥ 1.4.4；扩展运行时使用 omp 自带的 Bun，**不需要**本地安装宿主包。
- 仓库不声明 `dependencies`，不要创建 `node_modules`、`tsconfig.json`、`dist` 或 lockfile；宿主 `@oh-my-pi/*` 由 omp 进程内解析。
- 三种加载方式：`omp -e <repo>`；放到 `~/.omp/agent/extensions/omp-meme/`；或在 `~/.omp/agent/config.yml` 写 `extensions:`。
- `OMP_MEME_DIR` 只覆盖用户图库根（默认 `~/.omp/memes`），内置根始终是仓库 `memes/`。
- `manifest.description` 会整段进入该包每张图的 keywords；写宽泛描述会降低选图精度。
- `exportToZip` 会打包 pack 目录下所有非隐藏文件（含 `index.db`）；`default` pack 的目录就是用户根，导出它会递归整个用户根；指定不存在的图库会回退导出全部。
- 配置读取语义：`enabled` 只有严格 `=== false` 才关闭，`debug` 只有严格 `=== true` 才开启，`gear` 非法值回退 `auto`；启动时读一次，运行中外部修改不会热更新。
- 内置根只读，导入永远写用户根；`pick` 对用户/内置图库等权随机，不优先用户图库。
- `send_meme` 已标记 `approval: "read"`，默认审批模式下不会弹窗；`--auto-approve` 只用于调试其他工具。

## Testing & QA

- 框架：`bun:test`，共 10 个用例（`test/config.test.ts`、`test/library.test.ts`、`test/zip.test.ts`）。
- 覆盖：ZIP 往返/中文名、图库扫描与分类别名、目录/ZIP/单图/URL 导入、导出 ZIP、配置默认/持久化/损坏回退。
- 未覆盖：`src/index.ts` 的工具/事件/命令、`src/renderer.ts` 的 TUI 绘制、`src/image.ts` 的真实图片解码与缓存。这些靠人工冒烟。
- 新增测试约定：
  - 文件名 `test/<module>.test.ts`，标题用英文短句描述行为。
  - 模块级 `mkdtempSync(join(tmpdir(), "omp-meme-<module>-"))`，`afterAll` 递归清理；每个用例用独立子目录。
  - HTTP 用 `Bun.serve({ port: 0 })` + `http://127.0.0.1:${port}`，`try/finally` 中 `server.stop(true)`。
  - ZIP 夹具直接用被测的 `writeZip` 生成；图片内容可用任意字节，不依赖真实解码。
- 手工冒烟清单：`omp -e .` 启动无错误 → `/meme packs`（内置 24 张）→ `/meme send happy` → 情绪对话触发 `send_meme` 且图片在回复后 → `/meme debug on` 显示标签 → `/meme off` 后情绪对话不再调用 → `/meme import`/`export` 往返。
