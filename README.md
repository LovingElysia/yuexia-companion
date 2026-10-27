# 大月下 · 陪伴版（Yuexia Companion）

《崩坏3》大月下（月下誓约·予爱以心）的 Windows 桌面宠物陪伴程序：透明桌宠、头顶气泡与状态栏、大月下音色语音，以及可选的 Codex / DeepSeek Harness 联动。

> 这是**非官方的同人作品**，与米哈游（miHoYo / HoYoverse）无关，也未获其认可。本仓库的程序代码以 MIT 协议开源；角色形象、动画和游戏语音**不在**开源范围内，详见 [NOTICE.md](NOTICE.md)。

## 下载与运行

到 [Releases](../../releases) 下载完整发行版（程序 + 自带 Electron + 全部无损动画与配音，约 3.1 GB）。GitHub 单个附件不能超过 2 GB，所以压缩包分成了两段：

1. 下载 `yuexia-companion-lossless-2026-10-26.zip.001` 和 `.002`，放在同一个文件夹。
2. 合并成一个 zip（任选一种）：
   - 下载同一页里的 `join-parts.cmd` 放进该文件夹后双击；或
   - 在该文件夹打开命令提示符，运行：
     ```bat
     copy /b yuexia-companion-lossless-2026-10-26.zip.001 + yuexia-companion-lossless-2026-10-26.zip.002 yuexia-companion-lossless-2026-10-26.zip
     ```
3. 可用 `SHA256SUMS.txt` 校验；然后解压到任意位置（路径可以有中文）。
4. 双击 `创建桌面快捷方式.cmd` 生成桌面快捷方式，以后双击「月下陪伴版」即可启动。

不需要安装 Node、Python 或其他程序。

## 功能

- **桌宠**：透明窗口、拖动、右键菜单；待机样式、互动动作、日常、此生相携、时节、游乐园、魔法小游戏、礼物；「自动播放动作」默认开，互动动作出现得最多。
- **头顶状态栏**：左边 Codex 剩余额度，中间当前状态（待命 / 思考中 / 执行中 / 待批准 / 已完成），右边 DeepSeek 余额。
- **月下卡片**：闲聊（OpenAI 兼容接口，默认 DeepSeek），或让她把任务派给本机的 Codex / DeepSeek Harness，在卡片里看每一步、批准操作、收结果；会话可新建、切换、改名、删除。
- **语音**（可选）：接 GPT-SoVITS 语音服务（`127.0.0.1:9880`），按语气选择情绪参考音；显卡合成时边合成边播放。语音环境与模型权重不在本仓库和发行版中。
- **控制台**：所有设置；密钥只保存在本机 `%LOCALAPPDATA%\YuexiaCompanion\settings.json`，服务只监听 `127.0.0.1` 并校验来源。

## 从源码运行

```bash
npm install            # 安装 Electron 43.3.0
npm test               # 22 项测试；没有放 pet 文件夹时，其中一项会跳过
```

源码不含动作包。把发行版里的 `pet\` 文件夹复制到仓库根目录（或在控制台里指定动作包目录），然后：

```bash
npx electron desktop.cjs
```

更多实现细节见 [docs/开发说明.md](docs/开发说明.md)（文中的本机路径是开发环境的示例）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `desktop.cjs` | Electron 主进程：桌宠、气泡、头顶状态栏、卡片、控制台窗口 |
| `server.cjs` | 本机服务：静态文件、`/api/*`、SSE 事件 |
| `lib/` | 设置、对话、会话、语音、显卡检测、Codex / DSH 监视与派活、Token 统计 |
| `web/` | 卡片、控制台、状态卡、气泡、头顶状态栏页面；`events-worker.js` 让所有窗口共用一条事件连接 |
| `tools/` | 打包工具（`bundle.cjs`）与运行环境检测（`check.cjs`） |
| `test/` | `node --test` 测试 |

## 许可

- 程序代码：[MIT](LICENSE)。
- 角色形象、动画、图标、游戏语音与台词：不适用 MIT，见 [NOTICE.md](NOTICE.md)。
- 发行版附带的 Electron 与 Chromium 遵循各自的开源许可（发行版 `runtime\electron\LICENSE`、`LICENSES.chromium.html`）。
