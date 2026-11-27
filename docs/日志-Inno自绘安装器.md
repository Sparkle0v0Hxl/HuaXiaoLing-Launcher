# Inno Setup 7 安装器进度

- 用户已安装 Inno Setup 7.1.1，并指定用它；本地编译器在 `E:\Inno Setup 7\ISCC.exe`。本轮只做本地成品与验收，不自动发布。
- 安装流程和构建接口已经落盘：`installer/inno/setup.iss` 原生目录页先出现，确认后解包；`H:\HXL-pack\installer-build.js` 从独立构建目录按白名单打包，沿用 `pack.js` 调用契约。隔离小负载通过编译。
- 第一版预览用户指出背景不完整、系统向导感重。改为 720×405 等比展示整图，不裁边，只压暗左边为控制区；用贴图自绘交互按钮，沿用 Inno 的目录浏览、磁盘检查和后台安装。
- 用户又指出左侧压暗过重、控件和字体像旧式向导、无边框后无法拖动、关闭弹原生确认。新主题改为浅粉半透卡片与圆角按钮，关闭确认嵌入同一面板；拖动改用 `WM_NCHITTEST`，绕开 Inno Pascal 类不暴露 `OnMouseDown` 的限制。以上源码通过 ISCC 无输出编译检查，尚未用最新可执行文件验证。
- 上一版完整图预览实测窗口 720×405，启动后约 2 秒已找到子进程窗口，且目标目录未写入。真实点击脚本因当时窗口非前台而保护性拒绝；不能据此断言交互已通过。
- 新主题预览：约 2.7 秒已显示 720×405 置顶窗口，目标目录未创建；拖动区域返回 HTCAPTION=2；同主题关闭确认和继续安装通过窗口消息实测，最小化与恢复后可按开始安装写入测试文件。
- 完整负载白名单共 4200 文件。第一次静默安装在日志记录 `Installation process succeeded` 后、`Deinitializing Setup` 阶段退出 `-1073740771`，Windows 事件同时记录 `0xc0000005` / `0xc000041d`。修复为 `DeinitializeSetup` 主动调用 `HxlDetachDrag`，在 Pascal 回调释放前解除窗口子类化。
- 修后完整隔离安装退出 0，4200 个负载文件加 1 个卸载入口；主 EXE、app.asar、latest.json 的 SHA-256 与构建输入一致，`fsutil` 验证两个 EXE 为同一硬链接。目录内双击入口及 `--uninstall` 都打开新版卸载窗；测试未点击确认，不影响本机卸载注册项和快捷方式。
- 本地最终成品 `H:\deepseek-harness\default-workspace\_inno-smoke-src\verified\HuaXiaoLing-2.14.0-Setup-Custom.exe`，177193281 字节，SHA-256 `57b63733408bbea3c244a31db3053c65b63213378ca7019b3dce6644fa92c020`。完整成品启动探针首见窗口约 6.1 秒，720×405、置顶，未点击安装时目标目录不存在；同目录 `安装器首屏.png`。未执行正式发布；当前编译器输出标记为 Non-commercial use only。
