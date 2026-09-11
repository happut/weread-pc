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
RUNTIME_FILES="package.json main.js preload.js index.html renderer.js"

echo "==> 清理旧构建产物"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "==> 复制 Electron 运行时 (v$VERSION)"
ditto node_modules/electron/dist/Electron.app "$APP_DIR"

echo "==> 注入应用源码"
rm -rf "$APP_DIR/Contents/Resources/default_app.asar"
mkdir -p "$APP_DIR/Contents/Resources/app"
for f in $RUNTIME_FILES; do
  cp "$f" "$APP_DIR/Contents/Resources/app/"
done
# 顺手带上协议和说明
cp LICENSE "$APP_DIR/Contents/Resources/app/" 2>/dev/null || true

echo "==> 更新 Info.plist"
PLIST="$APP_DIR/Contents/Info.plist"
plutil -replace CFBundleName -string "WeRead PC" "$PLIST"
plutil -replace CFBundleDisplayName -string "WeRead PC" "$PLIST"
plutil -replace CFBundleIdentifier -string "com.happut.wereadpc" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$VERSION" "$PLIST"

echo "==> Ad-hoc 签名（本机可运行；未公证，他人首次打开需右键->打开）"
codesign --force --deep --sign - "$APP_DIR" >/dev/null

echo "==> 打 zip"
cd "$OUT_DIR"
ditto -c -k --sequesterRsrc --keepParent "$APP_NAME.app" "WeRead-PC-macOS-arm64-$VERSION.zip"
cd ..

echo "==> 完成: $OUT_DIR/WeRead-PC-macOS-arm64-$VERSION.zip"
