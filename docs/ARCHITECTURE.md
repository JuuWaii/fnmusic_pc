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
2. 隔离世界 preload 对媒体元素调用 `HTMLMediaElement.setSinkId`；
   主世界脚本代理 `AudioContext`（构造期 sinkId + suspend/resume 序列，
   处理 Chromium 对运行中上下文切换不生效的限制），并广播到全部 frame；
3. 配合 MutationObserver + 周期扫描，兼容 SPA 动态创建播放器的场景。

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

- 全局媒体键：在 main.js 中挂接 globalShortcut 即可（系统托盘已实现：tray.js，关闭按钮默认最小化到托盘）；
- 更多歌词源：扩展 guest-preload 的嗅探规则；
- 多服务器配置：settings.js 增加 profile 字段即可。