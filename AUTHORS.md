# 作者与贡献者

## 作者

**Sparkle0v0Hxl** —— 项目发起人、独立开发者与维护者。

- GitHub：<https://github.com/Sparkle0v0Hxl>
- 仓库：<https://github.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher>
- 职责：整体设计、界面与交互、启动器内核（硬链接切换 / 官方更新 / 抽卡记录 / 音乐与点歌台 / 公告聚合）、便携化打包与发布维护

界面插画（`src/assets/` 下的 13 个 png）是程序化生成的抽象装饰图，版权归作者所有。本仓库不附带任何第三方游戏的官方立绘或角色形象；想换成自己的图，放进数据目录的 `art-pack/` 即可。

## 贡献者

- **susgsudvgshghg**（[@susgsudvgshghg](https://github.com/susgsudvgshghg)）—— 二作，负责工具栏的体验优化与 bug 修复。

欢迎通过 Issue 与 Pull Request 参与；提交被合并后，名字会出现在这里。

## 致谢

本项目在设计与实现上明显受益于以下开源项目，详见 [README 的「许可与致谢」](README.md#许可与致谢) 一节：

- [Starward](https://github.com/Scighost/Starward) —— 主要参考对象，服务器切换、硬链接去重、多客户端共存的思路与大量交互设计来源
- XelLauncher —— 渠道包整理方式与 `load` 目录组织方式的参考
- [sql.js](https://github.com/sql-js/sql.js)（MIT）—— 读取本地抽卡 SQLite 数据库
