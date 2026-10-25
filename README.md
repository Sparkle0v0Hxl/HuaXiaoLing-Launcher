<div align="center">

# 花筱灵启动器 · HANABI STAGE

> 原神、崩坏：星穹铁道、绝区零、异环、明日方舟：终末地的启动器！
>
> A launcher for Genshin Impact, Honkai: Star Rail, Zenless Zone Zero, NTE and Arknights: Endfield.

当前版本 / Current version: **2.0.3**

**语言 / Language：** [中文](#中文) ｜ [English](#english)

</div>

---

<a id="中文"></a>

## 中文

一个本地优先的桌面游戏书架，基于 Electron。Minecraft、终末地、绝区零、鸣潮等游戏统一管理，附带抽卡记录、音乐播放、账号登录等工具。

### 这个仓库里有什么

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

#### 不在仓库里的两个组件

GitHub 单文件上限 100 MB，以下两个文件超限，**需要从 Release 下载后放回对应位置**：

| 文件 | 大小 | 放到哪里 |
|---|---|---|
| `花筱灵启动器.exe` | 238 MB | 仓库根目录 |
| `resources/endfield-packs/EndBilibili/` | 199 MB | 覆盖同名目录 |

不想自己拼装的话，直接下载 Release 里的 `HuaXiaoLing-2.0.3-Portable.zip`，解压即用。

### 运行

便携版，不需要安装：

```
花筱灵启动器.exe
```

如果显卡驱动有问题、启动白屏，用安全模式：

```
启动-安全模式.bat
```

安全模式会附加 `--safe-mode --no-sandbox --disable-gpu`，跳过硬件加速。

#### 从源码调试

```powershell
cd resources\app
npm install
npm start
```

需要 Node.js 18+ 和 Electron 45。

### 打包发版

```powershell
.\scripts\publish-portable.ps1 -Version 2.0.3 -Notes "修复 xxx`n优化 yyy"
```

产物在 `build\release\`：

- `HuaXiaoLing-2.0.3-Portable.zip` — 发布包
- `latest.json` — 更新清单（含 sha256 和大小）

脚本会自动排除 `data/`（用户数据）、`downloads/`（缓存）、`.bak` 备份、日志和本地清单。

#### 发版流程

1. 改 `resources/app/package.json` 的 `version`（**必须和 `-Version` 参数一致**，否则启动器认为更新无效）
2. 跑上面的打包脚本
3. 把 zip 传到 Release
4. 把 `latest.json` 的 `url` 改成实际下载地址
5. 推送 `latest.json`

> 版本号不能重复发布。已装 2.0.2 的用户，只有看到 2.0.3 才会收到更新。

### 数据存放在哪

| 模式 | 位置 |
|---|---|
| 默认 | `%USERPROFILE%\Documents\花筱灵启动器\data` |
| 便携模式 | 根目录下的 `data`（设置里可切换） |

抽卡记录、账号凭据（加密）、歌单、配置都在这里。**升级不会动这个目录。**

### 版本历史

#### 2.0.3
- 绝区零战绩查询：输入 UID 即可查看式舆防卫战、虚构叙事、危局强袭战战绩，含总分、评级与阵容详情
- 新增角色昵称映射，搜索、抽卡与歌单中的角色名支持常用简称
- 战绩查询接入云端缓存与本地索引，重复查询更快
- 修复若干界面细节

#### 2.0.2
- 修复米游社扫码登录：登录框不再反复弹出、来回重建
- 支持 v2 系列 cookie（`cookie_token_v2` 等），账号无角色时不再误判为未登录
- 登录失败显示具体原因，不再只有「登录超时」
- 工具页登录状态区分「正在读取 / 已登录 / 未登录」

#### 2.0.1
- 修复自更新：发现新版本、显示更新说明、带进度下载、sha256 校验、覆盖后自动重开

### 许可

MIT。第三方组件许可见 `LICENSES.chromium.html`、`LICENSE.electron.txt` 及各依赖自带的 LICENSE 文件。

<div align="right"><a href="#english">↓ English</a></div>

---

<a id="english"></a>

## English

A local-first desktop game library built on Electron. It unifies Minecraft, Arknights: Endfield, Zenless Zone Zero, Wuthering Waves and more in one place, with built-in gacha tracking, a music player and account login tools.

### What's in this repository

This repository contains the **complete source code and runtime resources**. Clone it and you can modify and build it yourself.

```
resources/
  app/                  ← The app itself (Electron main process + renderer)
    electron/           Main process code (37 modules)
    src/                Renderer (UI, styles)
    package.json        Version number is defined here
  updater/              Self-update scripts (HXL-Updater.ps1 / self-heal.ps1)
  netease-api/          Bundled NetEase Cloud Music service
  endfield-packs/       Endfield channel packs (Arknights / EndGlobal / EndOfficial / EndPlay / EndSteam)
scripts/
  publish-portable.ps1  Package & release script
  selftest-update.js    Self-update smoke test
```

#### Two components not in the repository

GitHub caps a single file at 100 MB. The two files below exceed that limit and **must be downloaded from the Release and put back in place**:

| File | Size | Where to put it |
|---|---|---|
| `花筱灵启动器.exe` | 238 MB | Repository root |
| `resources/endfield-packs/EndBilibili/` | 199 MB | Overwrite the directory of the same name |

If you'd rather not assemble it yourself, just download `HuaXiaoLing-2.0.3-Portable.zip` from the Release — unzip and run.

### Running

Portable build, no installation needed:

```
花筱灵启动器.exe
```

If you get a blank window due to graphics driver issues, use safe mode:

```
启动-安全模式.bat
```

Safe mode appends `--safe-mode --no-sandbox --disable-gpu` to skip hardware acceleration.

#### Debugging from source

```powershell
cd resources\app
npm install
npm start
```

Requires Node.js 18+ and Electron 45.

### Building a release

```powershell
.\scripts\publish-portable.ps1 -Version 2.0.3 -Notes "fix xxx`nimprove yyy"
```

Outputs land in `build\release\`:

- `HuaXiaoLing-2.0.3-Portable.zip` — the release package
- `latest.json` — update manifest (includes sha256 and size)

The script automatically excludes `data/` (user data), `downloads/` (cache), `.bak` backups, logs and local manifests.

#### Release checklist

1. Bump `version` in `resources/app/package.json` (**must match the `-Version` argument**, otherwise the launcher treats the update as invalid)
2. Run the packaging script above
3. Upload the zip to the Release
4. Point `url` in `latest.json` at the real download address
5. Push `latest.json`

> Version numbers cannot be reused. Users already on 2.0.2 will only receive an update when they see 2.0.3.

### Where data is stored

| Mode | Location |
|---|---|
| Default | `%USERPROFILE%\Documents\花筱灵启动器\data` |
| Portable | `data` under the root directory (switchable in settings) |

Gacha records, account credentials (encrypted), playlists and configuration all live here. **Upgrades never touch this directory.**

### Changelog

#### 2.0.3
- Zenless Zone Zero battle records: enter your UID to view Shiyu Defense, Fictional Narrative and Deadly Assault results with score, rating and team details
- Character nickname mapping, so search, gacha and playlists accept common aliases
- Battle records use a cloud cache plus a local index, so repeat lookups are faster
- Misc UI fixes

#### 2.0.2
- Fixed HoYoLAB QR-code login: the login dialog no longer pops up repeatedly or rebuilds itself
- Added support for v2-series cookies (`cookie_token_v2` etc.); accounts without characters are no longer misreported as logged out
- Login failures now show the actual reason instead of a bare "login timed out"
- The tools page now distinguishes "reading / logged in / logged out"

#### 2.0.1
- Fixed self-update: detects new versions, shows release notes, downloads with progress, verifies sha256, and relaunches automatically after an overwrite

### License

MIT. Third-party licenses are in `LICENSES.chromium.html`, `LICENSE.electron.txt`, and the LICENSE files bundled with each dependency.

<div align="right"><a href="#中文">↑ 中文</a></div>
