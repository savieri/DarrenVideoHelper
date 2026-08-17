# Darren Video Helper macOS Beta 安装说明

当前版本：`v1.2.0-beta.3`（预发布版，仅验证 macOS）

Chrome 不允许普通脚本静默安装未上架的扩展。因此安装器会自动完成 Native Host、权限和工具链自检，Chrome 扩展本身仍需手动“加载未打包的扩展程序”。这是 Chrome 的安全限制，不是安装器故障。

## 最简安装（4 步）

1. 解压整个 `DarrenVideoHelper-macOS-v1.2.0-beta.3.zip`，不要只单独取出某个文件。
2. 确认已安装 Homebrew `yt-dlp`。若没有，请在“终端”运行 `brew install yt-dlp`。
3. 双击 `install.command`；若 macOS 首次阻止打开，请右键它并选择“打开”。等待窗口显示 Native Host 自检通过。
4. 在自动打开的 `chrome://extensions/` 中启用“开发者模式”，点击“加载未打包的扩展程序”，选择同一解压目录里的 `extension` 文件夹。

安装后请保留整个解压目录，不要移动 `extension` 文件夹；Chrome 会从该固定位置加载它。安装器不会替换或移除你已经加载的其他扩展。

## 安装器会做什么

- 安装源码版 Native Host，并通过 `/usr/bin/python3` 启动；
- 使用 Homebrew `yt-dlp` 与包内的 `ffmpeg` / `ffprobe`；
- 设置执行权限、注册 Chrome Native Messaging Host 并运行强制自检；
- 打开 Chrome 扩展管理页和 Finder 中的 `extension` 文件夹，提示最后一步。

本包不包含旧的 PyInstaller / Python.framework Host，也不会绕过 Chrome 的扩展安装安全策略。

## 卸载

双击 `uninstall.command` 移除 Native Host 注册，然后在 `chrome://extensions/` 中移除扩展。

