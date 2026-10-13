#!/usr/bin/env bash
# 构建 macOS (arm64) 的 WeRead PC.app
# 不依赖 electron-builder / electron-packager：
#   - 本应用运行时只用 Electron 内置模块，无第三方依赖，无需打包 node_modules
#   - 直接复用 node_modules/electron/dist 里的运行时，注入源码即可
# 产物：release/WeRead-PC-macOS-arm64-<version>.zip
set -euo pipefail

APP_NAME="WeRead-PC"
VERSION=$(node -p "require('./package.json').version")
OUT_DIR="release"
APP_DIR="$OUT_DIR/$APP_NAME.app"

echo "==> 清理旧构建产物"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "==> 复制 Electron 运行时 (v$VERSION)"
ditto node_modules/electron/dist/Electron.app "$APP_DIR"

echo "==> 注入应用源码"
rm -rf "$APP_DIR/Contents/Resources/default_app.asar"
mkdir -p "$APP_DIR/Contents/Resources/app"
# 根级全部运行时模块（主进程 require + index.html script 引用），
# 用 glob 兜底，避免新增模块后打包漏文件产出坏包
for f in *.js index.html package.json LICENSE; do
  [ -f "$f" ] && cp "$f" "$APP_DIR/Contents/Resources/app/"
done

echo "==> 注入应用图标（美短猫书）"
if [ -f "assets/icons/WeRead-PC.icns" ]; then
  cp "assets/icons/WeRead-PC.icns" "$APP_DIR/Contents/Resources/WeRead-PC.icns"
  # 去掉 Electron 默认图标，避免误导
  rm -f "$APP_DIR/Contents/Resources/electron.icns"
else
  echo "!! 未找到 assets/icons/WeRead-PC.icns，保留 Electron 默认图标" >&2
fi

echo "==> 更新 Info.plist"
PLIST="$APP_DIR/Contents/Info.plist"
plutil -replace CFBundleName -string "WeRead PC" "$PLIST"
plutil -replace CFBundleDisplayName -string "WeRead PC" "$PLIST"
plutil -replace CFBundleIdentifier -string "com.happut.wereadpc" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$VERSION" "$PLIST"
if [ -f "assets/icons/WeRead-PC.icns" ]; then
  plutil -replace CFBundleIconFile -string "WeRead-PC.icns" "$PLIST"
fi

echo "==> Ad-hoc 签名（本机可运行；未公证，他人首次打开需右键->打开）"
codesign --force --deep --sign - "$APP_DIR" >/dev/null

echo "==> 打 zip"
cd "$OUT_DIR"
ditto -c -k --sequesterRsrc --keepParent "$APP_NAME.app" "WeRead-PC-macOS-arm64-$VERSION.zip"
cd ..

echo "==> 完成: $OUT_DIR/WeRead-PC-macOS-arm64-$VERSION.zip"
