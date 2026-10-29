# 版本维护与发布

项目使用版本标签触发 GitHub Actions：维护者完成改动与验证后推送 `vX.Y.Z`，Windows Release 工作流会构建并发布对应文件。不按日历自动生成没有改动的版本，也不自动安装更新到用户电脑。

当前初始版本为 `0.1.0`，首次发布固定标记为预发布；包含 `-beta.1` 等后缀的版本同样为预发布。后续不带后缀的版本按正式版本发布。工作流文件就绪不代表远端 CI 已经执行，实际运行记录以仓库的 Actions 页面为准。

## 普通改动

1. 在分支修改代码，更新必要的文档与验证记录。
2. 运行 `npm test` 与 `npm run test:e2e`；涉及打包时再运行 `npm run pack:win` 和 `npm run test:packaged`。
3. 提交并发起 Pull Request。Windows CI 会检查核心行为、真实 Electron 窗口以及独立打包后的应用；检查不使用真实 API Key 或私人聊天。
4. 检查通过后合并到 `main`。需要发布时再进入下面的发版流程。

## 发布新版本

先把 `main` 更新到准备发布的提交，并更新变更说明。确认工作区无未提交文件，再运行，例如发布 `0.1.1`：

```powershell
npm version 0.1.1 --no-git-tag-version
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v0.1.1"
git tag -a v0.1.1 -m "长离桌面助手 v0.1.1"
git push origin main
git push origin v0.1.1
```

`npm version` 会同步更新 package.json 与 package-lock.json。标签必须与 package.json 的版本完全一致，并指向实际构建提交。首次 `v0.1.0` 不需要再次运行 `npm version`，在已提交的初始版本上创建相应标签即可。

Windows Release 会依次执行版本核对、锁定依赖安装、核心测试、Electron 桌面回归、独立 Windows 打包和打包应用检查，然后生成 SHA256SUMS.txt。只有这些步骤成功，独立的发布任务才获得写权限，用 GitHub 内置 `GITHUB_TOKEN` 创建 Release 草稿、上传 `.exe` / `.zip` 与校验清单，再公开该 Release。无需配置个人 GitHub Token，也无需给 CI 提供模型密钥。

已存在的标签也可在 Actions → Windows Release → Run workflow 中手动填入执行。它会构建该标签指向的代码，而不是自动采用最新 main。首次创建草稿或附件上传失败后，可以修复问题并重跑：只有仍为草稿的版本才会被复用，同名附件通过 `gh release upload --clobber` 重新上传，全部成功后再公开。上传前和公开前都会再次核对草稿状态；上传再次失败会保留草稿，供后续恢复。已有公开 Release 会直接拒绝覆盖，需发布新版本，工作流也不会强行移动标签。维护者应让同一标签的发布交给工作流完成，避免在附件上传期间手动公开草稿。

普通 Windows CI 只有读取仓库的权限。发布任务只下载已经通过验证的构建文件，不运行仓库的 npm 安装或构建命令。Actions 的 Node 与上传工具使用官方当前主要版本，维护依赖时应一起检查这些版本。

## 下载与更新

用户从仓库 Releases 页面下载对应版本。首版提供手动下载更新；退出旧程序后再替换程序文件。模型设置、会话、记忆和授权保存在本机用户数据目录，不包含在 GitHub 源码或发布附件中。正式版与开发版的数据目录独立，首次打开正式版需要重新配置；不要在未确认数据范围时直接复制私人数据库到发布文件。

Windows 未签名发布文件可能由系统提示确认，发布说明应如实注明当前签名状态与已验证的平台。校验下载文件时，可在 PowerShell 运行：

```powershell
Get-FileHash -Algorithm SHA256 .\下载的文件名.exe
```

将输出与同一 Release 的 SHA256SUMS.txt 对照。哈希用于核对文件内容，不能代替签名或判断程序权限。

参考：[GitHub 版本发布](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)、[GitHub CLI release create](https://cli.github.com/manual/gh_release_create)、[官方 checkout](https://github.com/actions/checkout)、[官方 setup-node](https://github.com/actions/setup-node)、[官方上传附件](https://github.com/actions/upload-artifact)、[官方下载附件](https://github.com/actions/download-artifact)。
