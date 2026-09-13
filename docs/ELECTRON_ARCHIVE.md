# Electron 归档与清理

日期：2026-09-13。根据用户本轮明确要求，提前从活动项目移除旧客户端；这不代表原生功能或阶段 7 发布验收已经全部完成。

本机归档目录：`.legacy-archive/electron-20260913/`，已被 Git 忽略，不发布。

- `electron-source.zip`：清理前的源码、旧测试、npm 清单与锁文件、构建配置、工作流、图标、旧文档及许可快照。
- SHA-256：`EF681662434E1B3D318CD92462665075973C1B9C2113D93BAA370C169FFF7AEA`。
- `staged.patch`：清理前全部暂存差异，保留此前未提交重构。
- `git-index.snapshot`：清理前索引备份，供审计恢复，勿直接覆盖后续索引。
- `dev.config.json`：旧私人开发配置，单独保存在本机忽略目录，禁止提交或分享。

源码恢复时将 ZIP 解压到独立目录并按原始路径整理（ZIP 中独立文件为平铺条目）；需要精确目录与暂存状态时，在清理前 Git 基线上使用 `git apply --index staged.patch`。旧版本已提交历史仍在 Git 中。

已删除可重新生成的 `node_modules`、`dist`、npm/Electron/builder 缓存及构建日志；移除活动 Electron 源码、专属测试、npm 配置和自动发布工作流。保留原生工具链、通用 NAS 探查脚本及测试、隐私检查、原始 logo 与第三方归属声明。旧用户数据和浏览器调试资料未触碰。
