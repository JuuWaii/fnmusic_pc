# 飞牛音乐 Windows 原生客户端

使用 C#、WinUI 3/XAML 和 FFmpeg 构建的非官方 NAS 音乐客户端，目前处于阶段 4 开发预览。

已实现原生登录与加密会话恢复、分页曲库、播放/暂停/停止、进度拖动、音量与输出设备、双击切歌、当前页队列和四种播放模式。队列管理支持查看、播放所选、移除和清空；移除当前曲目或清空队列会停止播放。

## 构建与运行

```powershell
./scripts/native.ps1 bootstrap
./scripts/native.ps1 build
./scripts/native.ps1 test
./scripts/native.ps1 run
```

本机已有匹配 SDK 时可跳过 bootstrap。播放需要 PATH 中存在 FFmpeg；当前尚未捆绑可分发版本，也不是最终安装包。

[原生工程说明](native/README.md) · [阶段进度](docs/PHASE_STATUS.md) · [开发清单](docs/NATIVE_BACKLOG.md) · [FFmpeg 播放层](docs/FFMPEG_PLAYBACK.md)

歌曲搜索与分页已通过真实 NAS 只读验收，部分键盘及窗口交互复测仍待完成，见 [搜索状态](docs/NATIVE_SEARCH.md)。专辑/歌手、收藏和歌单、FN Connect、OAuth、桌面集成及发布验收仍待后续。

## Electron 归档

旧客户端已从活动源码和构建入口移除，归档位置及恢复说明见 [清理记录](docs/ELECTRON_ARCHIVE.md)。原生配置位于 `%LOCALAPPDATA%/FnMusic.Native/`；旧应用用户数据未删除。

辅助检查无需安装 npm 依赖：

```powershell
node --test tests/*.test.cjs
node scripts/check-privacy.js
```

本项目与飞牛官方无关联或背书。许可见 [LICENSE](LICENSE)，依赖及参考归属见 [第三方声明](THIRD_PARTY_NOTICES.md)。
