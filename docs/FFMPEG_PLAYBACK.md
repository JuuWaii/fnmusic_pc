# FFmpeg 播放层（阶段 3）

2026-09-12：根据用户要求，压缩音频改由 FFmpeg 解码，不再把原始 FLAC/MP3 等交给 Windows 系统解码器。

## 当前实现

WinUI 曲库 → NAS 鉴权 Range 流 → FFmpeg stdin → PCM stdout → MediaStreamSource → 音频设备。

- NAS 地址和令牌只由 HTTP 层持有；FFmpeg 命令行只包含固定选项、管道及数字时间点，不包含服务器、Cookie、曲名或用户文件路径。
- FFmpeg 输入协议限制为 `pipe`，禁止媒体内容间接读取本地文件或联网；不保留 stderr 原文，不生成歌曲临时文件。
- 以独立无窗口进程解码。换曲、停止、退出账号和关闭窗口会撤销读取并释放本次解码进程。
- Windows MediaPlayer 仅消费已经解码的 PCM，负责时钟、暂停、音量和音频设备输出；未启动 Windows 音乐应用。
- 预览 PCM 为 48 kHz / 16 bit / 双声道，尚不是原采样率无损直通或独占模式。
- 优先读取应用 `ffmpeg/ffmpeg.exe`；当前未捆绑二进制，开发预览使用系统 PATH 中已安装的 FFmpeg。

## 已验证和限制

使用本机生成的 WAV、FLAC、MP3、OGG 各 2 秒测试音频，验证完整解码、1 秒时间点重启解码、PCM 长度及非静音样本；损坏输入返回不含原文的错误。测试不接触用户歌曲。

当前 stdin 不可随机定位，因此跳转会从头重读并解码到指定时间点，大文件跳转可能较慢。依赖容器随机读取的格式（例如部分尾置索引 M4A/MP4）尚未覆盖，不能据此宣称支持所有 FFmpeg 格式。后续应接入 libavformat 自定义 AVIO 的受控 Range 回调，解决容器定位和大文件跳转，再扩展格式矩阵。不要用完整下载或把凭据放入 FFmpeg 命令行掩盖这一限制。

真实 NAS 的会话恢复、曲库、歌曲播放、暂停、恢复、跳转及设备切换已通过静音原生集成测试，并等待停止后的进程/流清理完成。验证调用生产 NativeMusicPlayer，不是网页播放器。合成音频也通过同一输出链路；完整窗口交互回归仍待后续。

阶段 4A 已接入当前页播放队列和自动下一首，规则测试通过；自动曲间切换的窗口验收仍待补齐。CUE 分轨、HLS 和输出设备热插拔属于后续子阶段。

## 依赖与发布

开发机的 FFmpeg 是已有 GPL 构建，仅用于本地验证，没有复制进源码或安装包。发布前须固定可追溯版本及校验值，审核完整构建选项，随包提供对应许可证、版权声明和满足该构建要求的源码材料。优先评估满足音频需求的 LGPL 构建；不启用 nonfree 组件。当前第三方声明不代表已经完成二进制分发合规。

参考：[FFmpeg 命令行文档](https://ffmpeg.org/ffmpeg.html)、[FFmpeg 许可说明](https://ffmpeg.org/legal.html)、[MediaStreamSource](https://learn.microsoft.com/en-us/uwp/api/windows.media.core.mediastreamsource?view=winrt-26100)。
