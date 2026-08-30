# FN Music PC（fnmusic_pc）

> 飞牛音乐（fnOS Music）网页的 PC 客户端封装 —— 网页嵌套播放，登录态保持，支持 FN Connect 远程访问与音频输出设备选择。

飞牛音乐是飞牛 fnOS（飞牛私有云）内置的音乐应用。本客户端将其网页版（通常运行在 NAS 的 **5666** 端口）
以原生窗口形式嵌入 PC，让你像使用本地音乐软件一样听歌。

## ✨ 功能特性

| 需求 | 实现 |
| --- | --- |
| 登录态保持 | 网页会话（Cookie / LocalStorage）持久化在用户数据目录，**重启免登录** |
| FN Connect 外网访问 | 设置中可配置官方远程访问地址，支持「自动：本地优先，失败切远程」 |
| 欢迎页配置 | 首次启动显示欢迎配置页，服务器地址可随时在设置中修改 |
| 音频输出设备 | 应用内下拉自由选择音频输出设备，立即生效 |
| 零侵入网页 | 不修改飞牛网页任何文件，网页升级后客户端依旧可用 |
| 桌面歌词（可选） | 捕获网页接口歌词数据，驱动可拖动、置顶的歌词悬浮窗 |
| 隐私 | 不收集任何数据；仓库不含任何个人信息（内网地址 / Cookie / Token） |

## 📦 快速开始

```bash
# 1. 安装依赖（国内网络如遇 Electron 下载失败，见下方「镜像加速」）
npm install

# 2. 启动
npm start
```

> PowerShell 5.1 不支持 `&&` 连接符，请分行执行：先 `npm install`，再 `npm start`。

首次启动会显示欢迎页：填写你的飞牛门户地址（例如 `http://192.168.x.x:5666`）与
FN Connect 远程地址（可选），点击「保存并开始使用」。

> 飞牛音乐的实际网页入口为「门户根地址 + /music」：客户端会自动在服务器地址后追加
> 音乐入口路径（默认 `/music`，可在设置中修改或留空），因此只需填写门户地址即可直接进入飞牛音乐。

> 镜像加速（可选）：
>
> ```bash
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install
> # 或使用仓库自带脚本：node scripts/electron-download.js
> ```

## 🔐 登录态与隐私说明

- 登录信息（Cookie 等）由 Chromium 会话持久化在系统用户数据目录
  （`%APPDATA%/FNMusicPC`），**仅保存在本机**，应用不读取、不上传、不备份；
- 设置中提供「清除登录数据」按钮（Cookie / 缓存 / LocalStorage）；
- 本客户端不收集任何统计、埋点或日志上报；
- 仓库代码中**不含**任何真实内网地址、远程域名、Cookie 或 Token；
  开发期个人地址通过 `dev.config.json`（已被 .gitignore 排除）提供，
  模板见 `dev.config.json.example`。可随时运行 `npm run check:privacy` 复核。

## 🛰 FN Connect 远程访问

FN Connect 是飞牛官方提供的远程访问服务，用于没有公网 IP 的场景下从外网访问 NAS。
开启后，在飞牛系统「FN Connect」页面可以获取到形如 `https://xxxx.fnos.net` 的
**网页访问地址**（官方代理域名后缀包括 `fnos.net`、`5ddd.com`、`trzznas.com`）。

- 在设置 → 服务器 → 「FN Connect 远程地址」填入该地址；
- 访问模式选「自动」：客户端优先连接本地地址，失败时自动切换到远程地址；
- 若远程地址证书异常（个别网络环境），可临时开启「忽略证书错误」（高级设置）。

> 官方文档：[如何远程访问到飞牛 NAS？](https://help.fnnas.com/articles/v1/access/how-access)

## 🔊 音频输出设备

- 工具栏 🔊 按钮或「设置 → 音频输出设备」选择设备，立即生效；
- 原理：客户端在网页运行时注入 `setSinkId` 调用（不修改网页源码），
  将页面播放器（HTMLAudioElement / AudioContext）的声音定向到所选设备；
- 若列表为空：请确认已进入飞牛音乐页面后再刷新（设备枚举依赖页面环境）。
- 纯 HTTP 的内网地址在 Chromium 中属于非安全上下文，客户端启动时会自动将你配置的
  服务器地址标记为安全上下文以启用设备枚举；**更换服务器地址后需重启客户端生效**。

## 🎤 桌面歌词（可选功能）

- 工具栏 ♪ 按钮或「设置 → 桌面歌词」开启；
- 歌词来自飞牛音乐网页自身接口（客户端仅在本机解析展示，不对外传输）；
- 歌词窗口可拖动、可点击穿透、可关闭；当前歌曲无歌词时显示提示。

## 🧱 技术架构

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

```text
src/
├── main/                 # 主进程
│   ├── main.js           # 入口：生命周期、单实例、冒烟测试
│   ├── window-manager.js # 壳窗口 + WebContentsView（网页承载）
│   ├── guest-preload.js  # 注入网页的隔离世界脚本（音频设备/进度上报/消息桥，零侵入）
│   ├── guest-mainworld.js # 注入网页主世界的脚本（AudioContext 定向 / 歌词嗅探）
│   ├── settings.js       # 设置持久化（userData/settings.json）
│   ├── server-url.js     # 地址校验与解析（本地 / FN Connect）
│   ├── audio-devices.js  # 音频输出设备枚举与切换
│   ├── lyrics.js         # 桌面歌词（LRC 解析 + 悬浮窗）
│   ├── security.js       # 权限 / 证书 / 新窗口策略
│   └── ipc.js            # IPC 总线
├── renderer/             # 壳页面（本地页面，非网页）
│   ├── toolbar.*         # 顶栏（导航 / 设备 / 歌词 / 设置）
│   ├── welcome.*         # 欢迎配置页
│   ├── settings.*        # 设置页
│   └── lyrics.*          # 桌面歌词悬浮窗
└── preload.js            # contextBridge 白名单桥
```

## 🧪 开发与验证

```bash
npm start              # 启动应用
npm run smoke          # 冒烟测试（自动加载并自检后退出）
npm run check:privacy  # 隐私合规检查（IP / 凭据 / 个人配置）
npm run pack           # 打包（目录形式，快速验证）
npm run dist           # 打包（NSIS 安装包）
```

## 🙏 参照的开源项目（致谢）

本项目的架构与交互设计参考了以下优秀开源项目（均为 MIT License，详情与许可全文见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）：

- [Electron](https://github.com/electron/electron) —— 桌面应用框架
- [electron-builder](https://github.com/electron-userland/electron-builder) —— 打包工具
- [Listen1](https://github.com/listen1/listen1_chrome_extension) —— 多平台音乐聚合播放器（网页封装思路）
- [YesPlayMusic](https://github.com/qier222/YesPlayMusic) —— 高颜值第三方音乐播放器（界面交互参考）
- [MusicBox](https://github.com/musicbox/musicbox) —— 终端音乐播放器（桌面歌词展示思路）

> 飞牛（fnOS / FN Music / FN Connect）为飞牛科技（fnOS）的产品与服务。
> 本客户端为第三方开发的非官方封装，与飞牛官方无任何关联或背书；相关商标归其各自所有者。

## 📄 License

[MIT](LICENSE) © fnmusic-pc contributors