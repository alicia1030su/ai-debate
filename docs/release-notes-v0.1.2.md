# AI Debate v0.1.2

v0.1.2 是 v0.1.1 之后的收尾版本。功能与界面不变。

## 修复

- **从全新检出运行 `npm test` 现在可以成功**：各测试套件会先构建自己需要的产物（core 的 `lib/`、前端的 `assets/`、服务端的 bundle），不再依赖开发者机器上恰好留着的旧产物。此前在一个干净副本里跑 `npm test`，core 的 7 个测试会因为找不到 `packages/core/lib/*.js` 直接失败。
- **构建产物不再进入版本库**：`packages/web/static/assets/` 由 `npm run build` 生成，仓库只保留源文件与 `theme.css`、`index.html`。删掉 `assets/` 后重新构建可完整还原。

## 发布流程强化

- Windows 与 Linux 的发布任务会在上传前分别跑一遍**以打包产物为对象**的完整验收（25 项 HTTP 流程 + 14 项 Linux 安装流程），任一失败即中止，不会产出附件。
- 发布说明按标签自动选择（`docs/release-notes-<tag>.md`），已发布的标签与资产不允许覆盖。

## 升级

覆盖程序即可，数据目录与配置不变。

## 校验

同一 Release 附带 `SHA256SUMS.txt`，格式为 `<sha256>  <文件名>`。
