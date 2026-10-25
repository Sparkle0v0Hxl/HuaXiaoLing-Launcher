# 花筱灵启动器

> 原神、崩坏：星穹铁道、绝区零、异环、明日方舟：终末地的启动器！

一个本地优先的桌面游戏书架，基于 Electron。Minecraft、终末地、绝区零、鸣潮等游戏统一管理，附带抽卡记录、音乐播放、账号登录等工具。

当前版本：**2.0.2**

---

## 这个仓库里有什么

本仓库包含**完整源码与运行资源**，clone 下来即可修改、构建。

```
resources/
  app/                  ← 应用本体（Electron 主进程 + 渲染层）
    electron/           主进程代码（37 个模块）
    src/                渲染层（界面、样式）
    package.json        版本号以这里为准
  updater/              自更新脚本（HXL-Updater.ps1 / self-heal.ps1）
  netease-api/          内置网易云音乐服务
  endfield-packs/       终末地渠道包（Arknights / EndGlobal / EndOfficial / EndPlay / EndSteam）
scripts/
  publish-portable.ps1  打包发布脚本
  selftest-update.js    自更新自测
```

### 不在仓库里的两个组件

GitHub 单文件上限 100 MB，以下两个文件超限，**需要从 Release 下载后放回对应位置**：

| 文件 | 大小 | 放到哪里 |
|---|---|---|
| `花筱灵启动器.exe` | 238 MB | 仓库根目录 |
| `resources/endfield-packs/EndBilibili/` | 199 MB | 覆盖同名目录 |

不想自己拼装的话，直接下载 Release 里的 `HuaXiaoLing-2.0.2-Portable.zip`，解压即用。

---

## 运行

便携版，不需要安装：

```
花筱灵启动器.exe
```

如果显卡驱动有问题、启动白屏，用安全模式：

```
启动-安全模式.bat
```

安全模式会附加 `--safe-mode --no-sandbox --disable-gpu`，跳过硬件加速。

### 从源码调试

```powershell
cd resources\app
npm install
npm start
```

需要 Node.js 18+ 和 Electron 45。

---

## 打包发版

```powershell
.\scripts\publish-portable.ps1 -Version 2.0.3 -Notes "修复 xxx`n优化 yyy"
```

产物在 `build\release\`：

- `HuaXiaoLing-2.0.3-Portable.zip` — 发布包
- `latest.json` — 更新清单（含 sha256 和大小）

脚本会自动排除 `data/`（用户数据）、`downloads/`（缓存）、`.bak` 备份、日志和本地清单。

### 发版流程

1. 改 `resources/app/package.json` 的 `version`（**必须和 `-Version` 参数一致**，否则启动器认为更新无效）
2. 跑上面的打包脚本
3. 把 zip 传到 Release
4. 把 `latest.json` 的 `url` 改成实际下载地址
5. 推送 `latest.json`

> 版本号不能重复发布。已装 2.0.2 的用户，只有看到 2.0.3 才会收到更新。

---

## 数据存放在哪

| 模式 | 位置 |
|---|---|
| 默认 | `%USERPROFILE%\Documents\花筱灵启动器\data` |
| 便携模式 | 根目录下的 `data`（设置里可切换） |

抽卡记录、账号凭据（加密）、歌单、配置都在这里。**升级不会动这个目录。**

---

## 版本历史

### 2.0.2
- 修复米游社扫码登录：登录框不再反复弹出、来回重建
- 支持 v2 系列 cookie（`cookie_token_v2` 等），账号无角色时不再误判为未登录
- 登录失败显示具体原因，不再只有「登录超时」
- 工具页登录状态区分「正在读取 / 已登录 / 未登录」

### 2.0.1
- 修复自更新：发现新版本、显示更新说明、带进度下载、sha256 校验、覆盖后自动重开

---

## 许可

MIT。第三方组件许可见 `LICENSES.chromium.html`、`LICENSE.electron.txt` 及各依赖自带的 LICENSE 文件。
