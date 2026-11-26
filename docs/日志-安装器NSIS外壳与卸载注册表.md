# 安装器 NSIS 外壳与卸载注册表 —— 现场日志

> 2026-11-27 记录。压缩上下文前必读本文件，避免重复踩坑。

## 一、用户报障（原话）

- m09009：「@H:\HXL-pack\dist\HuaXiaoLing-2.14.0-Setup.exe 你这个也不是新的安装器呀」
- m09015：「你确定上传了新的安装器和卸载吗？」
- m09036：「打开也是完全的纯NSIS安装器」
- m09047：「我运行版本的卸载也不是新版的，你都干了啥？」
- m09091：「记得重新上传新的安装包，这版本不发增量，前面有提过，发增量换不了新的安装包和卸载」
- m09104：「老用户能正常弹窗更新完整包吧？」
- m09105：「你看看TRAE的日志，它不是打包过吗？」
- m09119：「我记得都交接记录有说呀，你还是没看全哦，还是压缩上下文失忆了，你自己弄个日志，免得压缩上下文忘记了」

## 二、交接文档里的关键事实（`H:\TRAE\花筱灵启动器-2.13.1后全部改动-交接文档.md` §6.1）

> - 结构：**Electron 安装器 + NSIS 外壳**；payload 只放启动器 `resources` + `latest.json`。
> - 安装时复用安装器自己的 Electron 运行时，只把 exe 复制并改名，用 `resedit` 写图标与版本信息（2.13.1.0）。
> - `process.noAsar=true`，`resedit` / `pe-library` / `launcher.ico` 走 `asarUnpack`。
> - 安装包 **283,002,550B → 174,554,812B（166.5MiB）**；locales 55 个/48.8MB → 2 个/1.1MB。
> - 沙箱四阶段实测：新包安装 / 自带卸载 / 自绘安装器安装 / 启动器静默卸载全部通过；安装后 asar SHA256 与新构建一致；正式版、源码、快捷方式、注册表前后指纹一致。

**结论：NSIS 外壳是设计的一部分，不是配错。** 我不该擅自把 `win.target` 从 `nsis` 改成 `portable`（已改，需评估是否回退）。

## 三、待查清的问题

1. **NSIS 外壳应该怎么配才「不喧宾夺主」**：现在 `nsis.oneClick=false` + `allowToChangeInstallationDirectory=true` → 用户看到的是完整 NSIS 向导（欢迎→目录→进度→完成）。正确形态应该是 NSIS 只做「静默解包到临时目录 + 启动 Electron 安装器」，用户只看到我们的自绘界面。
2. **打包时是否走了正确的 installer-build.js 路径**：`H:\HXL-pack\installer-build.js` 调 `npx electron-builder --win --publish never`，如果 package.json 的 nsis 配置是向导式，出来的就是向导。
3. **卸载注册表指向错误**（已修一半）：修前指向 `H:\deepseek-harness\default-workspace\_tmp-overlay-e2e`（已删除的端到端测试目录），已改成 `H:\花筱灵启动器`。
4. **运行副本里的旧 NSIS 卸载器**：`H:\花筱灵启动器\Uninstall 花筱灵启动器.exe`（363044 B，FileVersion 2.8.0，11-02）还没删。
5. **本版不发增量包**（m09091）：`latest.json` 的 `deltas` 要清空，只发完整包。

## 四、结论：`portable` 才是正确形态（已实测确认）

### 交接文档的「NSIS 外壳」到底指什么
交接文档 §6.1 写「Electron 安装器 + NSIS 外壳」。这个「NSIS 外壳」**指的是 electron-builder 的 `portable` target**（portable 本质就是一个 NSIS 自解压 SFX），**不是 `nsis` target**（那才是向导式安装程序）。

原来的 `installer/package.json` 配的是 `"target": [{ "target": "nsis" }]` + 一整套 `nsis` 段（oneClick:false / allowToChangeInstallationDirectory:true / 一整套向导文案），所以打出来是**纯 NSIS 向导**，用户看到「完全的纯 NSIS 安装器」——这就是 m09036 报的现象。

### portable 实测结果（2026-11-27 05:46–05:51）
- 产物：`H:\HXL-pack\dist-installer\HuaXiaoLing-Setup Setup 2.14.0.exe`，**150.89 MB（158218572 B）**，sha256 `61E705FF8B6D7F5B52D6E9C316ECA39C267FE61DDD77CB0134218D59AB14C43A`。
- 双击行为：①NSIS SFX 先把运行时解包到 `%TEMP%\<随机名>\`（约 407 MB，耗时 ~40 秒）②启动 `HuaXiaoLing-Setup.exe` ③**我们自己的 Electron 自绘窗口出现**（736×488，title「花筱灵启动器」）。
- 像素分析（`_installer-shot\portable-installer.png`，736×488）：**深色 49.4% / 粉色系 9.0% / 纯白 4.7% / 低饱和灰 2.1%** —— 深色+粉色主导，**不是** NSIS 向导那种灰白底。确认是自绘界面。
- 解包目录结构正确：`resources\app.asar`（安装器本体 956 KB）+ `resources\payload\{latest.json, resources\{app.asar 51.8 MB, app.asar.unpacked, azur-channel, netease-api, updater, elevate.exe}}`。

### 已做的改动（正确）
- `H:\花筱灵启动器-源码\installer\package.json`：`win.target` `nsis` → `portable`；删掉整个 `nsis` 段；加 `"portable": { "artifactName": "${productName} Setup ${version}.${ext}" }`。

## 五、下一步

1. 清空 `latest.json` 的 deltas（本版不发增量，m09091）。
2. 删运行副本里的旧 NSIS 卸载器 `H:\花筱灵启动器\Uninstall 花筱灵启动器.exe`（2.8.0）。
3. 确认老用户能正常弹窗更新完整包（m09104）。
4. 重跑 pack.js 重新发布。
