# 原生认证与播放：最小工程决策

初稿日期：2026-09-11。以下保留阶段 1 的决策背景。

2026-09-12 更新：阶段 2 已完成，真实原生登录及重启会话恢复已验证。用户指定阶段 3 改用 FFmpeg 解码；下文原始流交给 Windows 解码的候选方案已被替换。当前实现、测试与限制见 [FFmpeg 播放层](FFMPEG_PLAYBACK.md)，实时进展见 [阶段进度](PHASE_STATUS.md)。

## 1. 认证入口

先实现原生连接设置和密码登录界面。网页代码已确认密码入口、SHA-256 字段和 deviceId，但本轮用户使用已有网页登录，并未独立重放密码登录。首次原生验证必须由用户在新客户端输入账号密码，不能复制浏览器 Cookie 数据库作为正式实现。

现有服务初始化后，网页引导代码将 allowPasswordLogin 设为 true；这不保证每个 NAS OAuth 账户都已配置可用于音乐密码入口的密码。原生界面需要正确展示服务端错误，不能自动重试错误密码或替用户修改账号。

API 适配器先覆盖已经无 authx 实测成功的曲库、元数据、原始流与转码操作。不在仓库中加入网页混淆的应用密钥。若密码登录实际要求额外签名，再以明确错误证据确定兼容方案，不因单次错误自动切换认证方式。

NAS OAuth 保留为独立认证提供器。当前只确认网页回调 `/music/oauth/result`；尚无证据证明服务端接受原生 loopback 或自定义协议回调。不得擅自注册 OAuth 客户端、修改 NAS 配置或使用任意 redirect_uri。没有确定原生回调方案前，该功能须明确标注未完成，不能用嵌入整个音乐网页替代原生应用。

## 2. 会话生命周期

建议状态为：未配置 → 未登录 → 登录中 → 已登录 → 验证失效/连接失败。

- 原生登录成功后只在内存保留所需会话材料；用户选择记住登录时，通过 Windows 保护机制加密保存会话令牌。无需为了免登录长期保存原始密码或密码摘要。
- 稳定 deviceId 与连接身份关联。不同服务器或不同用户切换时隔离会话、HTTP Cookie 容器、曲库缓存及播放器。
- 启动时解密并验证 `/user/me`。401 或明确未授权业务码表示会话失效；网络超时不能直接误判为密码错误或删除可用会话。
- 退出时调用已确认的退出接口并清理本地敏感状态；服务端不可达时仍完成本地退出，明确说明远端撤销尚未确认。
- 没有证实 refresh 接口，不安排盲目刷新或自动重试登录。服务端超期后的行为须实际验证。

阶段 3 的必测用例：关闭并重启原生进程仍能验证会话；不记住登录时重启需要登录；损坏/不可解密凭据安全失败；切换服务器不串会话；断网与会话失效有区别；退出后不能恢复旧会话。

## 3. 媒体边界

WinUI UI 只消费播放状态、进度和命令；NAS DTO 不直接穿透到 XAML。播放源解析器返回协议、媒体类型与受控资源引用，凭据不进入 ViewModel 展示字段、日志或系统媒体信息。

原始流：优先验证 Windows MediaPlayer + MediaSource。鉴权 HTTP 层负责会话和 Range，向播放器提供可随机读取的数据源，避免为了播放先完整下载整首音乐。微软提供 [MediaSource.CreateFromStream](https://learn.microsoft.com/en-us/uwp/api/windows.media.core.mediasource.createfromstream?view=winrt-26100) 接收 IRandomAccessStream；具体 HTTP 随机访问适配仍需实现与实测。

HLS：优先验证 [AdaptiveMediaSource.CreateFromUriAsync(Uri, HttpClient)](https://learn.microsoft.com/en-us/uwp/api/windows.media.streaming.adaptive.adaptivemediasource.createfromuriasync?view=winrt-26100)，该重载允许自定义下载用 HttpClient 和请求头。必须验证清单、初始化段和媒体段的认证一致性；不能假设设置一次 Uri 就会继承其他 HTTP 客户端或 Chrome 的 Cookie。

上述为候选方案，不是已完成实现。HttpClient 的类型、自动重定向、Cookie 容器和分段请求行为须在具体 Windows SDK 下验证。凭据只发送到已配置且明确允许的来源，不全局设置可跨主机泄露的认证头，不关闭证书校验。

本轮已有原始 FLAC 浏览器解码、seek 与 HLS MP4 资源结构证据，但 Windows FLAC/HLS 解码能力、输出设备切换、CUE 和其他格式仍未实测。若原生解码失败，先区分认证、数据源、容器和编码问题，再评估替代媒体库及许可证。

## 4. 工具链与下一轮交付

本机能找到 dotnet 主程序，但 `dotnet --list-sdks` 无输出；未发现常用 Visual Studio Installer 的 vswhere。因此当前没有可确认的 C#/WinUI 编译工具链，不把没有构建过的工程称为可运行版本。

下一轮直接推进阶段 2：确认并配置受支持的 SDK，建立最小解决方案、原生欢迎/连接/登录/设置界面，以及独立 API 客户端和会话存储边界。先做到本机可构建启动，再进入阶段 3 的真实登录与播放。不继续扩大网页静态脚本抓取范围。

仍需要后续实测的事项：密码入口、NAS OAuth 原生回调、原生进程重启会话恢复、HLS 心跳和解码、FN Connect 外网连接。它们不阻止搭建最小工程，但阻止宣称完整迁移或发布。
