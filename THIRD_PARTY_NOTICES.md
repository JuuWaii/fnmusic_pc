# 第三方开源声明（THIRD PARTY NOTICES）

本项目（FN Music PC）是使用以下开源软件构建的，并参考了若干开源播放器的设计。
所有第三方软件均保留其原始版权与许可证。以下按项目列出。

---

## 1. 直接依赖（运行时 / 构建）

### Electron
- 主页: https://github.com/electron/electron
- 许可证: MIT License
- 说明: 桌面应用运行框架。其分发的 Chromium / Node.js 组件遵循各自的许可证
  （BSD-3-Clause 等），详见 https://www.electronjs.org/docs/latest/tutorial/electron-licenses
- Copyright (c) Electron contributors

### electron-builder
- 主页: https://github.com/electron-userland/electron-builder
- 许可证: MIT License
- 说明: Windows 安装包（NSIS）打包工具
- Copyright (c) 2015 Loopline Systems

---

## 2. 设计参考（未复制其代码，仅借鉴交互 / 架构思路）

### Listen1
- 主页: https://github.com/listen1/listen1_chrome_extension
- 许可证: MIT License
- 借鉴点: 将网页音乐服务以多平台客户端形式封装的整体思路
- Copyright (c) 2017 Listen1 contributors

### YesPlayMusic
- 主页: https://github.com/qier222/YesPlayMusic
- 许可证: MIT License（见其仓库 LICENSE 文件）
- 借鉴点: 桌面音乐客户端的交互布局与视觉层级
- Copyright (c) 2021 qier222

### MusicBox（音乐盒）
- 主页: https://github.com/musicbox/musicbox
- 许可证: MIT License
- 借鉴点: 桌面歌词的展示与同步交互
- Copyright (c) 2017 musicbox contributors

---

## 3. 产品与商标声明

- 飞牛（fnOS）、飞牛音乐（FN Music）、FN Connect 为飞牛科技（fnOS）的产品与服务。
- 本客户端为**第三方非官方封装**，与飞牛科技无关联、无背书；
  使用飞牛服务请遵循飞牛官方用户协议与隐私政策。
- 相关商标与名称归其各自所有者所有，本项目对其的使用仅为事实性描述。

## 4. MIT License（全文）

以上 MIT 许可项目均适用以下条款：

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> 各项目的完整许可文本以各项目仓库中的 LICENSE 文件为准。
