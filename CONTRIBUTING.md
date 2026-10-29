# 参与贡献

需求范围见 [docs/PRD.md](docs/PRD.md)，当前计划见 [docs/PLAN.md](docs/PLAN.md)。较大功能请先通过 Issue 说明使用场景；修复可以直接提交小范围 Pull Request。

## 开发检查

使用 Node.js 24 和 npm，在项目目录执行：

```powershell
npm ci
npm run check
npm test
npm run test:e2e
```

涉及打包或资源路径时，还需运行 `npm run pack:win` 和 `npm run test:packaged`，记录实际环境与未覆盖项目。模型测试默认使用本机夹具；真实服务验证应明确标出服务、模型及结果，不提交真实凭据。

## 提交内容

- 说明问题、预期行为、最终改动和实际验证结果；界面改动可附不含私人数据的截图。
- 保留现有会话、明确记忆和授权的兼容性；数据格式改变时说明迁移行为。
- 不向页面暴露任意 IPC、Shell、文件或模型凭据入口，工具结果以本地执行器为准。
- 不提交 `.env`、数据库、聊天记录、日志、访问令牌或其他私人素材。配置示例仅保留占位值。
- 新依赖或素材需说明用途、来源与许可，保留第三方声明。

文档与界面以中文为主。功能变化时同步更新需求、开发计划和变更记录。发布流程见 [docs/RELEASING.md](docs/RELEASING.md)。
