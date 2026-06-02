# CLAUDE.md

本文件供 Claude Code / Cursor 等 AI 助手快速理解项目上下文。

## 项目概述

**pomodoro-timer** — 基于 Electron 的 macOS 桌面番茄钟应用。

- 专注 25 分钟 / 短休息 5 分钟 / 长休息 15 分钟（每 4 个专注后）
- 系统托盘常驻，关闭窗口不退出应用
- 中文 UI，深色主题

远程仓库：`https://github.com/a270401800/pomodoro-timer`

## 常用命令

```bash
# 安装依赖
npm install

# 启动应用（macOS）
npm start
```

无测试框架、无构建打包脚本；Electron 直接加载源码运行。

## 架构

```
main.js          主进程：窗口、托盘、系统通知、IPC 监听
preload.js       预加载桥：contextBridge 暴露 electronAPI
renderer.js      渲染进程：计时逻辑、UI 更新、localStorage
index.html       页面结构
style.css        样式（深色主题 #0f0f1a）
```

### 进程间通信（IPC）

| 方向 | 通道 | 用途 |
|------|------|------|
| 渲染 → 主 | `notify` | 系统通知 |
| 渲染 → 主 | `update-tray-title` | 更新托盘 tooltip / 菜单 |
| 渲染 → 主 | `set-always-on-top` | 窗口置顶 |
| 主 → 渲染 | `timer-action` | 托盘菜单：pause / resume / reset |
| 主 → 渲染 | `always-on-top-changed` | 同步置顶 checkbox 状态 |

渲染进程通过 `window.electronAPI` 访问（见 `preload.js`），禁止在渲染进程直接使用 Node.js。

### 计时器状态机

`renderer.js` 中 `state` 对象：

- `mode`: `'work'` | `'break'`
- `status`: `'idle'` | `'running'` | `'paused'`
- 使用 `endTime` 绝对时间戳 + 250ms tick，避免后台 tab 漂移
- 偏好与今日统计存 `localStorage`（`pomodoro-prefs`、`pomodoro-sessions`）

### 主进程要点（main.js）

- 单实例锁 `requestSingleInstanceLock()`
- 关闭窗口 → `hide()` 到托盘，仅托盘「退出」或 `before-quit` 时真正退出
- 托盘图标程序化绘制（16×16 番茄模板图）

## 修改指南

- **改计时规则**：编辑 `renderer.js` 顶部常量（`WORK_SECONDS` 等）
- **改 UI 文案/布局**：`index.html` + `style.css`
- **改托盘/通知行为**：`main.js`
- **新增 IPC 能力**：同时改 `preload.js`（暴露 API）、`main.js`（ipcMain 处理）、`renderer.js`（调用）

## 约定

- **AI 交流语言**：永远使用简体中文（见全局 `~/.claude/CLAUDE.md`）
- UI 语言：简体中文
- 注释：主进程已有中文注释；保持简洁，只注释非 obvious 逻辑
- 不提交 `node_modules/`（已在 `.gitignore`）
- 最小化改动范围，匹配现有 vanilla JS 风格，勿引入不必要框架

## 环境

- Node.js 18+（开发/运行 Electron）
- macOS 为主要目标平台（托盘、`setTemplateImage`、Apple 钥匙串 SSH 等按 macOS 优化）
- `npm start` 脚本硬编码 macOS Electron 路径；其他平台需调整 `package.json` 的 start 脚本
