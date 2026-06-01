/**
 * Electron 主进程入口
 *
 * 职责概览：
 * 1. 创建并管理主窗口（番茄钟 UI）
 * 2. 创建系统托盘图标与右键菜单
 * 3. 通过 IPC 接收渲染进程消息（通知、托盘更新、窗口置顶等）
 * 4. 实现「关闭窗口 → 最小化到托盘」而非真正退出（macOS 常见行为）
 * 5. 单实例锁：防止重复启动多个应用
 */

const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain } = require('electron');
const path = require('path');

// 主窗口实例；关闭时默认隐藏到托盘，不销毁
let mainWindow = null;
// 系统托盘实例
let tray = null;
// 标记用户是否主动选择「退出」；为 false 时点击窗口关闭按钮只会 hide
let isQuitting = false;

/**
 * 程序化绘制 16×16 托盘图标（番茄形状）
 *
 * 逻辑：
 * - 分配 RGBA 像素缓冲区（每像素 4 字节）
 * - 以 (7.5, 7.5) 为圆心，用距离公式画圆形主体（番茄）
 * - 边缘 1 像素做抗锯齿：距离在 5.5~6.5 之间时 alpha 渐变
 * - 顶部小矩形区域画「叶子」高光
 * - 最终只写黑色 + alpha，配合 setTemplateImage 适配 macOS 菜单栏深浅色
 */
function createTrayIcon() {
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - 7.5;
      const dy = y - 7.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // 圆内完全不透明，圆外 1px 过渡，再外透明
      const alpha = dist < 5.5 ? 255 : dist < 6.5 ? Math.max(0, Math.round((6.5 - dist) * 255)) : 0;
      // 顶部叶子：x 在 6~9、y 在 1~3，且靠近中心竖线
      const leafAlpha = (x >= 6 && x <= 9 && y >= 1 && y <= 3 && (x === 7 || Math.abs(x - 7.5) < 1.2)) ? 255 : 0;
      const finalAlpha = Math.max(alpha, leafAlpha);
      canvas[idx] = 0;       // R
      canvas[idx + 1] = 0;   // G
      canvas[idx + 2] = 0;   // B
      canvas[idx + 3] = finalAlpha; // A
    }
  }
  const img = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  // macOS 模板图：系统根据菜单栏主题自动反色
  img.setTemplateImage(true);
  return img;
}

/** 创建托盘：设置图标、默认提示文字，并构建初始右键菜单（idle 状态） */
function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('番茄钟');
  updateTrayMenu('idle', null);
}

// 记录上次托盘菜单对应的计时器状态，避免相同 status 时重复 rebuild 菜单
let lastTrayStatus = 'idle';

/**
 * 根据计时器状态刷新托盘右键菜单
 *
 * @param {string} status - 计时器状态，如 'idle' | 'running' | 'paused' 等
 * @param {string|null} tooltip - 鼠标悬停提示；有值时更新 setToolTip
 *
 * 菜单项：
 * - 第一行：当前状态文字（不可点击）
 * - 显示/隐藏窗口
 * - 暂停/继续（向渲染进程发 timer-action）
 * - 重置
 * - 窗口置顶（checkbox，双向同步主窗口与渲染进程）
 * - 退出（设置 isQuitting 后真正 quit）
 */
function updateTrayMenu(status, tooltip) {
  if (!tray) return;
  if (tooltip) tray.setToolTip(tooltip);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: tooltip || '番茄钟',
      enabled: false, // 仅展示，不可点击
    },
    { type: 'separator' },
    {
      label: mainWindow && mainWindow.isVisible() ? '隐藏窗口' : '显示窗口',
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      // running 时显示「暂停」，否则显示「继续」
      label: status === 'running' ? '暂停' : '继续',
      click: () => {
        if (mainWindow) {
          // 通过 preload 暴露的 API，渲染进程监听 'timer-action' 控制计时器
          mainWindow.webContents.send('timer-action', status === 'running' ? 'pause' : 'resume');
        }
      },
    },
    {
      label: '重置',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('timer-action', 'reset');
        }
      },
    },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: mainWindow ? mainWindow.isAlwaysOnTop() : false,
      click: (menuItem) => {
        if (mainWindow) {
          mainWindow.setAlwaysOnTop(menuItem.checked);
          // 通知渲染进程同步 UI 上的置顶开关状态
          mainWindow.webContents.send('always-on-top-changed', menuItem.checked);
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

/**
 * 创建主窗口并加载 index.html
 *
 * 安全配置：
 * - contextIsolation: true — 渲染进程与 preload 隔离
 * - nodeIntegration: false — 渲染进程不能直接 require Node 模块
 * - preload — 通过 preload.js 安全地向页面暴露有限 API
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 520,
    minWidth: 340,
    minHeight: 480,
    resizable: true,
    title: '番茄钟',
    backgroundColor: '#E3F2FD', // 加载前背景色，减少白屏闪烁
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile('index.html');

  // 用户点窗口关闭按钮时：不退出应用，仅隐藏到托盘（除非 isQuitting 为 true）
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// ─── IPC：主进程 ← 渲染进程（preload 转发） ───

/** 渲染进程请求显示系统原生通知（计时结束等） */
ipcMain.on('notify', (event, title, body) => {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show();
  }
});

/**
 * 渲染进程更新托盘提示与菜单
 * title 通常为剩余时间或阶段名；status 变化时才 rebuild 菜单（减少开销）
 */
ipcMain.on('update-tray-title', (event, title, status) => {
  if (tray) {
    tray.setToolTip(`番茄钟 - ${title}`);
    if (status && status !== lastTrayStatus) {
      lastTrayStatus = status;
      updateTrayMenu(status, `番茄钟 - ${title}`);
    }
  }
});

/** 渲染进程设置窗口是否始终置顶（与托盘菜单 checkbox 可能双向触发） */
ipcMain.on('set-always-on-top', (event, flag) => {
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(flag);
  }
});

// ─── 应用生命周期 ───

// 单实例：若已有实例在运行，本进程直接退出；否则监听 second-instance 唤起已有窗口
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  // 用户再次启动应用时，显示并聚焦已有窗口
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();
  });

  // macOS：所有窗口关闭后仍保留托盘，不调用 app.quit()
  app.on('window-all-closed', () => {
    // On macOS, keep app alive via tray
  });

  // macOS：点击 Dock 图标时重新显示主窗口
  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });

  // 真正退出前标记 isQuitting，避免 close 事件里再次被 preventDefault
  app.on('before-quit', () => {
    isQuitting = true;
  });
}
