# omp-meme

仓库：<https://github.com/gdushang/omp-meme>

给 [omp](https://omp.sh) 用的表情包插件：模型按聊天情绪挑一张**静态图片**，图片追加在本轮回复末尾显示。参考 [dsh-meme](https://github.com/yyh-001/dsh-meme) 的图库思路，适配终端的图片协议，不发送动图。

## 功能

- **回复末尾配图**：模型调用 `send_meme` 选图，`agent_end` 后会话一空闲就把图片作为独立消息追加到最后一条回复下面。
- **图库自动扫描**：目录名即分类（tag），文件名即描述；兼容 dsh-meme 的 `manifest.json` + `memes/<tag>/` 结构。
- **内置图库**：自带「大肥鱼」24 张静态表情（来源 dsh-meme）。
- **ZIP 导入/导出**：`/meme import`、`/meme export`，与图库目录结构一致。
- **终端降级**：不支持 Kitty / iTerm2 / SIXEL 时显示 `[Image: ...]` 占位，不影响会话。

## 安装

从 git 安装（推荐）：

```sh
omp plugin install https://github.com/gdushang/omp-meme.git
omp plugin list          # 确认已安装
```

临时加载（不安装）：

```sh
git clone https://github.com/gdushang/omp-meme.git
omp -e ./omp-meme
```

手动持久（用户级）：把仓库放进 `~/.omp/agent/extensions/omp-meme/`，或在 `~/.omp/agent/config.yml` 写仓库的绝对路径：

```yaml
extensions:
   - ~/.omp/agent/extensions/omp-meme
```

插件清单在 `package.json#omp.extensions`；安装或修改后重启 omp 生效。

## 图库

默认根目录：

| 根 | 位置 | 说明 |
| --- | --- | --- |
| 用户 | `~/.omp/memes`（`OMP_MEME_DIR` 可覆盖） | 导入的图库、自建图库 |
| 内置 | 插件目录 `memes/` | 随插件分发，只读 |

目录结构（dsh-meme 兼容）：

```text
~/.omp/memes/<pack>/
  manifest.json          # 可选：{"id":"fish","name":"大肥鱼","tags":["whale"]}
  memes/
    happy/ok.png         # 分类 = happy，描述 = ok
    sad/求饶.png
```

也支持把图片直接放在根目录（归入「默认图库」）。目录层级最多 6 层；`png`/`jpg`/`jpeg`/`webp`/`bmp` 会收录，GIF/SVG 等跳过。

模型选图时：

- `tag`：`happy` / `angry` / `sad` / `shy` / `confused` / `daily`，也接受「开心」「生气」等中文别名；
- `query`：在描述、文件名、关键词、图库名里做全词匹配。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/meme` | 查看统计和用法 |
| `/meme list [分类或关键词]` | 列出匹配图片（最多 20 条） |
| `/meme packs` | 列出图库及图片数量 |
| `/meme send [分类或关键词]` | 立即发一张（不触发模型生成） |
| `/meme import <目录、图片、.zip 或 ZIP 的 URL>` | 导入图库到用户根目录；URL 必须指向 ZIP 包；无参数时弹出输入框 |
| `/meme export [图库] [目标.zip]` | 导出图库；默认导出全部用户图库到当前目录 |
| `/meme rescan` | 重新扫描图库目录 |
| `/meme path` | 显示图库根目录 |
| `/meme on` / `/meme off` | 开启/关闭表情包（关闭后不注入提示词、从活动工具移除 `send_meme`、不发图） |
| `/meme gear [off\|auto\|active\|always]` | 斗图档位：关闭 / 看气氛 / 活跃 / 每轮都发 |
| `/meme status` | 查看开关、档位与调试文本状态 |
| `/meme debug [on\|off]` | 是否在图片上方显示 `[表情: 描述 · 分类]`，默认关闭 |

导出 ZIP 的条目为 `<pack>/...`，可直接再导入。

## 工具

`send_meme(tag?, query?)`：

- 按分类/关键词从所有已扫描图库随机挑一张；
- 返回描述与分类，图片由扩展在本轮回复结束后追加，模型无需写图片路径；
- 未命中时返回真实分类统计，便于模型换词或改纯文字回复。

回复里默认只显示图片，不显示 `[表情: 描述 · 分类]` 文本；需要排查选图时用 `/meme debug on` 打开标签。开关、档位与调试状态存在用户图库根目录的 `omp-meme.json`。

## 主动配图

插件在 `before_agent_start` 按档位向主会话的系统提示追加引导，并声明「大肥鱼」「肥鱼」「蓝色大肥鱼」都是模型自己；子代理不注入。

| 档位 | 什么时候发 |
| --- | --- |
| `off` | 不主动，只回文字；用户明确要求发表情/发图/斗图时才调用 |
| `auto`（默认） | 看气氛：接梗、吐槽、卖萌、情绪表达时主动发；对方说正事/严肃话题时克制 |
| `active` | 大部分合适的回合都主动发；明确说正事时才克制 |
| `always` | 每轮都必须发一张；只有工具报错或没有候选时才允许纯文字 |

```text
/meme gear           # 查看当前档位
/meme gear auto      # 切换并持久化
```

档位与开关写在 `<userRoot>/omp-meme.json`（`{enabled, debug, gear}`）。`/meme off` 是全局关闭：不注入提示词并从活动工具中移除 `send_meme`；`/meme on` 恢复。

## 工作方式

```text
send_meme 工具 → 记录待展示图片（按 session）
      │
agent_end（回复生成完）→ 轮询到会话空闲
      │
pi.sendMessage({customType:"omp-meme", display:true, details:{path,caption,tag}})
      │
自定义消息渲染器 → 读取本地图片 → Image 组件（Kitty/iTerm2/SIXEL）
```

图片字节不写入会话；`details` 只存路径，重新加载会话时按路径重读。

## 限制

- 只支持静态图片；GIF/APNG/WebP 动图不会播放。
- `--print` 等非 TUI 模式没有图片渲染，也来不及等会话空闲，表情不会显示。
- 终端必须支持图形协议（omp 设置 `terminal.showImages` 默认开启）；不支持时退化为文本占位。
- 图片不发送给模型（模型只看得到描述），不会增加视觉 token。

## 开发

```sh
bun test
```

核心的 ZIP 读写与图库扫描不依赖 omp 宿主；渲染和工具投递用 `omp -e <本目录>` 做冒烟。
