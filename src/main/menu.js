'use strict';
/**
 * 应用菜单（极简）
 * 菜单栏默认隐藏（autoHideMenuBar），按 Alt 可临时唤出。
 */
const { Menu, app } = require('electron');
const logger = require('./logger');

/** 组装并设置应用菜单 */
function setupMenu() {
  const isDev = !app.isPackaged;
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '设置…',
          accelerator: 'Ctrl+,',
          click: () => {
            // 由 ipc 模块注册的打开设置窗口函数注入（避免循环依赖）
            if (global.__fnmusicOpenSettings) global.__fnmusicOpenSettings();
          },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '返回',
          accelerator: 'Alt+Left',
          click: () => { if (global.__fnmusicNav) global.__fnmusicNav('back'); },
        },
        {
          label: '前进',
          accelerator: 'Alt+Right',
          click: () => { if (global.__fnmusicNav) global.__fnmusicNav('forward'); },
        },
        { label: '重新加载', accelerator: 'Ctrl+R', click: () => { if (global.__fnmusicNav) global.__fnmusicNav('reload'); } },
        { label: '主页', accelerator: 'Ctrl+Home', click: () => { if (global.__fnmusicNav) global.__fnmusicNav('home'); } },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        ...(isDev ? [{ role: 'toggleDevTools', label: '开发者工具' }] : []),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 / 开源许可',
          click: () => { if (global.__fnmusicOpenSettings) global.__fnmusicOpenSettings(); },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  logger.info('应用菜单已初始化');
}

module.exports = { setupMenu };
