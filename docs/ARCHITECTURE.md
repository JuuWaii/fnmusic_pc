# 架构说明（ARCHITECTURE）

## 1. 总体结构

本客户端采用 Electron 的「壳 + 网页视图」模式：

- **壳（Shell）**：本地页面（工具栏 / 欢迎页 / 设置页 / 歌词窗），负责窗口交互与配置；
- **网页视图（WebContentsView）**：承载飞牛音乐网页，位于独立持久分区
  `persist:fnmusic-guest`，登录态（Cookie / LocalStorage）持久化在用户数据目录；
- 壳与网页视图之间**零共享**：网页侧只允许通过注入脚本（guest-preload）上报歌词 / 播放进度，
  无法访问任何本地能力。

## 2. 数据流

```
┌──────────────────────────── 主进程 ────────────────────────────┐
│ settings.js ── server-url.js ── window-manager.js ── lyrics.js │
│      │              │                  │               │      │
│      └── ipc.js ◄──► 壳页面（preload 白名单桥）                │
│              ▲                                                │
│              │ 歌词/进度上报（只读）                            │
│      guest-preload.js（注入网页，零侵入）                       │
└───────────────────────────────────────────────────────────────┘
```

## 3. 音频输出设备路由

1. 用户在工具栏 / 设置中选择设备 → 主进程保存 deviceId 并通过 IPC 下发给 guest-preload；
2. guest-preload 调用 `HTMLMediaElement.setSinkId` 与 `AudioContext.setSinkId`，
   将网页播放器的声音定向到所选设备；
3. 配合 MutationObserver + 周期扫描，兼容 SPA 动态创建播放器的场景。

## 4. 桌面歌词管线（可选功能）

1. guest-preload 钩住 `fetch` / `XMLHttpRequest`，嗅探 JSON 响应中的 LRC 歌词字段；
2. 上报到主进程 lyrics.js 解析为时间轴行（mm:ss.xx）；
3. guest-preload 每秒上报播放进度，lyrics.js 每 250ms 二分定位当前行并推送给歌词悬浮窗；
4. 歌词窗口：无边框、置顶、可拖动、可点击穿透，数据仅存内存，不落盘。

## 5. 安全模型

- 壳页面与歌词窗口：sandbox + contextIsolation，仅暴露白名单 API（preload.js）；
- 网页视图：sandbox + contextIsolation，session 级权限只放行 media / notifications / fullscreen；
- 证书错误默认拦截（可在设置中临时放行，用于 FN Connect 隧道异常场景）；
- 新窗口一律交给系统浏览器，且仅限 http/https；
- 地址校验：仅 http/https，拒绝 URL 内嵌凭据；
- 数据最小化：不采集、不上报、不落盘任何网页内容（歌词仅存内存）。

## 6. 隐私设计（个人信息零入库）

- 代码与文档中不含真实内网地址 / 远程域名 / 凭据；
- 用户个人地址保存在 `%APPDATA%/FNMusicPC/settings.json`（本机）；
- 开发期地址可放 `dev.config.json`（git 忽略）；
- `npm run check:privacy` 自动扫描版本库，防止个人信息误提交。

## 7. 可扩展点

- 系统托盘常驻 / 全局媒体键：在 main.js 中挂接 tray 与 globalShortcut 即可；
- 更多歌词源：扩展 guest-preload 的嗅探规则；
- 多服务器配置：settings.js 增加 profile 字段即可。
