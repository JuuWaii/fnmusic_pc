# 飞牛音乐 WinUI 3 原生预览

阶段 4 的原生预览工程。已实现登录、加密会话恢复、分页曲库、FFmpeg 播放及队列管理；NAS OAuth 和 FN Connect 仍待适配。旧 Electron 已归档，见 ../docs/ELECTRON_ARCHIVE.md。

## 构建与运行

当前验证平台为 Windows x64。固定 .NET SDK 10.0.401、Windows App SDK 1.8.260804001 和 Windows SDK BuildTools 10.0.26100.9169；依赖由各项目的 packages.lock.json 锁定。构建为自包含、非 MSIX 预览程序，不需要为本轮测试注册包或开启开发者模式。

从仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/native.ps1 bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/native.ps1 build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/native.ps1 test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/native.ps1 run
```

bootstrap 从微软下载已固定版本 SDK，校验 SHA-512 后解压至 `.tools/`；不修改系统 PATH。已具备匹配 SDK 时可以跳过 bootstrap。依赖还原只使用 native/NuGet.Config 中的官方源。修改依赖时需主动更新锁文件，常规构建使用 locked-mode。

当前生成路径：`src/FnMusic.App/bin/Release/net10.0-windows10.0.26100.0/win-x64/FnMusic.App.exe`。运行需保留同目录依赖文件，不可只复制 exe。它不是最终安装包。

## 项目边界

- FnMusic.App：原生窗口、中文资源、ConnectionViewModel，异步操作期间禁用重复提交。
- FnMusic.Core：连接身份、业务错误、会话存储接口。
- FnMusic.Infrastructure：NAS HTTP 接口、响应校验、普通连接设置。
- FnMusic.Windows：按当前 Windows 用户和连接身份保护的 DPAPI 会话存储。
- FnMusic.Tests：无真实凭据的可执行 C# 验证集，覆盖 HTTP/凭据边界和真实 DPAPI 行为。

HTTP 自动重定向关闭。服务器错误不直接显示原始 body 或异常消息。原始密码仅用于当次登录，不写配置或日志；SHA-256 摘要同样不持久保存。令牌仅在用户选择记住登录时经 DPAPI 加密保存，不提供明文降级。

本机配置位于 `%LOCALAPPDATA%/FnMusic.Native/`，与 Electron 配置分离。服务器地址属于本机普通设置，不会被写入仓库。Cookie 文件、浏览器调试资料或 HAR 都不应纳入打包。

## 验证范围

已完成 Debug/Release 编译及原生窗口启动，中文资源能显示，实际服务器连接检查成功。12 项 C# 测试涵盖来源隔离、重定向拒绝、401 清理、错误响应、大小限制、密码摘要、头注入拒绝、首次会话清理、DPAPI 加密与连接绑定。

首次用户登录发现“会话目录不存在时清理抛错”，已修复并加入回归测试。用户随后确认真实密码登录成功；关闭并启动新的原生进程后已观察到“已恢复登录”。后续进展见 [阶段进度](../docs/PHASE_STATUS.md)。

## 阶段 3：FFmpeg 预览

已新增分页曲库、播放/暂停/停止、进度、音量、静音和输出设备选择。解码使用 FFmpeg，Windows 只接收 PCM 输出。当前开发预览需要 PATH 中存在 `ffmpeg.exe`，不捆绑本机 GPL 二进制。格式矩阵、跳转限制及发布要求见 [FFmpeg 播放层](../docs/FFMPEG_PLAYBACK.md)。

测试程序可额外传入 `--ffmpeg` 执行本机合成音频解码验证；`--skip-dpapi` 仅用于没有正常用户配置的沙箱，并明确输出 SKIP，不代表 DPAPI 已重新测试通过。

Debug 应用支持显式 `--verify-synthetic-playback`（内存合成音频）和 `--verify-native-playback`（本应用已保存的真实会话）集成检查；两者均静音执行并退出，在对应 bin 目录写入 `playback-verification.json`。Release 不包含此入口。报告必须在进程退出后读取，并确认它晚于所测二进制，避免误读旧结果。真实 NAS 的核心链路和正常用户 DPAPI 已通过，详见阶段记录。

阶段 4A 已加入当前页队列、上一首/下一首与四种播放模式。28 项原生测试通过；窗口自动切歌回归、完整音乐功能和发布验收仍待后续。

支持双击歌曲行播放。进度条在拖动时预览目标，松手后跳转；已完成合成音频真实鼠标拖动与双击验证。Debug 参数 `--preview-synthetic` 打开静音交互测试窗口，使用合成曲目且不读取会话，Release 不启用此模式。后续事项见 [开发清单](../docs/NATIVE_BACKLOG.md)。

搜索窗口验收可同时传入 `--preview-synthetic --preview-search`，生成 122 首合成曲目；查询 `0` 可检查三页结果，查询 `slow` 模拟忽略取消的 20 秒旧请求，用于检查清空后结果不会被覆盖。该附加参数仅在 Debug 合成模式中生效，不访问 NAS。

Debug 参数 `--verify-native-collections` 使用本应用已保存会话，对专辑/歌手列表、详情及歌曲分页执行只读验收，结束后自动退出；脱敏结果写入对应输出目录的 `collection-verification.json`。数据不足的检查会记录为跳过，Release 不启用此入口。

Debug 窗口回归：`--preview-synthetic --preview-collections` 提供两页专辑/歌手、两页详情歌曲、空详情及 20 秒延迟详情。追加 `--verify-collection-window` 可执行窗口内状态断言，写入 `collection-window-verification.json` 并自动退出；不模拟鼠标，不访问 NAS。

Debug 参数 `--verify-native-favorites` 只读核验当前账户收藏，写入脱敏 `favorite-verification.json` 后退出。数据不足时分页检查会标记跳过；不执行收藏增删。

## 工具链参考

- [.NET 发布清单](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json)
- [Windows App SDK 1.8 发布说明](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/release-notes/windows-app-sdk-1-8)
- [非打包 WinUI 3 应用](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/unpackage-winui-app)
