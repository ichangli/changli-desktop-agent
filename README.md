# 长离桌面助手

以《鸣潮》长离为角色的 Windows 文字桌面助手，支持本地会话、明确记忆和少量电脑工具。采用 Electron + Vue 3 + TypeScript + SQLite。

这是非官方同人项目，与游戏官方无关联。当前使用“离”字占位形象，不附带官方立绘、音乐或角色音色。原创程序代码采用 [MIT 许可证](LICENSE)，第三方与角色说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

[版本下载](https://github.com/lchangli/changli-desktop-agent/releases) · [问题反馈](https://github.com/lchangli/changli-desktop-agent/issues) · [开发计划](docs/PLAN.md) · [验证记录](docs/VERIFICATION.md)

## 当前状态

v0.1.0 首次预览版提供 Windows x64 ZIP 与单文件便携版，通过 GitHub Releases 分发。14 项核心测试、Electron 桌面回归及实际独立程序检查已通过，覆盖会话恢复、流式停止、记忆管理、工具授权和配置预设。下载文件与远端构建状态以 Releases、Actions 页面为准。

已有用户反馈真实 API、聊天、记忆与工具检查通过；自动化模型测试使用本机 SSE 夹具，应用启动测试使用启动桩。两类证据分别记录在 [验证记录](docs/VERIFICATION.md)，不将测试夹具称为真实供应商验证。

## 使用

目标平台为 Windows 10/11 x64，目前实际测试环境为 Windows 11 x64（10.0.26300）。从 Releases 下载 Windows 文件：ZIP 版解压完整目录后运行其中的程序；便携 EXE 版直接启动。发行版自带运行环境，不需要安装 Node.js 或 npm。当前发行文件未做数字签名，应用图标暂使用 Electron 默认图标。

1. 打开“连接设置”，点“使用 DeepSeek 预设”，填写自己的 API Key 并保存，再检查连接。也可从下拉建议选择地址/模型，或手动配置其他服务。
2. 返回聊天页发送消息。回复逐步显示，可停止、手动重试和切换会话；关闭窗口即退出，重新打开后继续聊天。
3. 需要记忆时，在记忆面板主动新增，或输入“记住，……”后确认内容与类别。支持修改和删除，普通聊天不会自动创建长期事实。
4. 在“电脑工具”中添加应用，选择 `.exe` 后自动命名；核对路径并允许启动。之后可说“打开 应用名”，也能随时撤销授权。名称可修改，无需填写内部 ID。
5. 请求“看看电脑状态”，或点击面板按钮，读取真实 CPU 和内存采样。GPU 与温度当前显示不支持。

默认启动为明确标识的本地模拟模式，用于体验界面与存储；保存云端模型配置后才使用对应服务。模拟模式不会自行发起模型请求，面板中的电脑工具仍执行真实操作。

![Windows 便携版实机截图，内容为本地模拟测试夹具](docs/images/preview.png)

## 模型与数据

DeepSeek 预设的完整地址为 `https://api.deepseek.com/chat/completions`，模型为 `deepseek-flash`。当前适配器对官方域名显式使用非思考模式，未实现思考内容的工具轮回传。地址或模型也可以手填；接入范围为 Chat Completions / SSE 文本流与 `tools/tool_calls`，不承诺各家扩展协议完全兼容。

配置云端模型时，近期消息、适用记忆、工具结果、应用名称/内部标识/授权状态及角色提示会发送给所填服务，应用启动路径不作为模型配置发送。连接检查也会发起一次简短请求，可能产生服务费用。

| 数据 | 位置与处理 |
| --- | --- |
| 正式版会话、记忆、设置、授权与工具记录 | `%APPDATA%/ChangliDesktopAgent/chat.sqlite`，及 SQLite 的 WAL/SHM 文件 |
| 开发版数据 | `%APPDATA%/ChangliDesktopAgent-dev/`，与正式版分开 |
| API Key | Electron 后台使用 Windows safeStorage 加密后存入数据库，不回传页面，不写入源码或普通日志 |
| 聊天与记忆正文 | 保存在本机数据库，正文未加密 |

正式版不会自动导入开发版或其他应用的数据。本项目不读取、改写或同步其他 QQ 机器人的配置、历史或记忆。开发/测试时可通过 `CHANGLI_DATA_DIR` 指定独立目录，应用不自动加载 `.env`。

## 更新版本

新版本通过 [GitHub Releases](https://github.com/lchangli/changli-desktop-agent/releases) 发布。关闭正在运行的应用，再下载并使用新版程序；数据放在上述用户目录中，与发行文件分开。不要用下载文件覆盖数据目录。

当前更新方式是手动下载新版，尚未实现应用内自动更新。维护者按版本标签发布，具体步骤见 [发版说明](docs/RELEASING.md)；不会仅因日历到期生成没有改动的版本。

## 当前边界

- 只支持文字聊天，尚无语音、Live2D、主动消息、提醒、附件分析或通用电脑控制。
- 应用启动仅使用本地选择并获准的 `.exe`，不拼接 Shell 命令或额外参数。选择同一目标会复用记录；文件变化会使旧授权失效。
- 工具成功表示执行器收到实际结果。应用启动成功不代表已登录、播放音乐或完成应用内部操作；已提交系统的启动不能保证撤回。
- 每轮历史最多取最近 20 条有效消息、合计 24000 字符；记忆最多召回最近 8 条、合计 4000 字符。删除长期记忆不会删除原聊天，近期历史中的原文仍可能进入模型上下文。
- 生成超时 90 秒，连接检查超时 15 秒，单次工具超时 10 秒；每次回复最多 3 轮、6 次工具调用，不静默自动重试。

## 从源码开发

使用 Node.js 24 和 npm，依赖版本由 `package-lock.json` 固定。已验证的开发环境为 Node 24.15.0 / npm 11.12.1，Electron 45.1.0、Vue 3.5.44、TypeScript 5.9.3。TypeScript 版本受当前 `vue-tsc` 兼容性约束。

```powershell
npm ci
npm run dev
```

检查与本机构建：

```powershell
npm run check
npm test
npm run test:e2e
npm run build
npm start
```

`test:e2e` 用临时目录与本机模型夹具操作真实 Electron 窗口，不使用个人模型凭据；截图写入忽略的 `test-results/`。首次安装可能需要下载 Electron 运行文件。开发时也可双击“启动长离.cmd”，它会构建后运行开发版。

独立发行构建与验证：

```powershell
npm run pack:win
npm run test:packaged
npm run dist:win
npm run test:portable
node scripts/release.mjs manifest
```

`pack:win` 构建 Windows 目录版供本机检查；`dist:win` 生成发行文件。普通 `build` 的 `out/` 仍依赖项目资源和依赖目录，不能作为独立发行包。

## 参与与反馈

欢迎提交可复现的问题和小范围改进，见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交问题时提供版本、Windows 环境、操作步骤和脱敏错误信息；不要上传真实密钥或完整私人数据库。安全问题见 [SECURITY.md](SECURITY.md)，版本改动见 [CHANGELOG.md](CHANGELOG.md)。

需求以 [PRD](docs/PRD.md) 为准，结构与进度见 [PLAN](docs/PLAN.md)。运行时角色提示位于 [prompts/changli.md](prompts/changli.md)，只加载其中的运行时分段，开发验证样例不会作为用户历史加载。
