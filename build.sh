#!/usr/bin/env bash
# 跨平台构建 WeRead PC（macOS arm64/x64 · Windows x64 · Linux x64）
# 不依赖 electron-builder / electron-packager：
#   - 运行时只用 Electron 内置模块，无第三方依赖，无需打包 node_modules
#   - 复用/下载官方 Electron 预编译运行时，注入源码即可
#
# 用法：
#   bash build.sh                 # 仅 macOS arm64（复用本地 node_modules/electron/dist）
#   bash build.sh --all           # 四平台全打
#   bash build.sh --target win32-x64
#
# 产物：release/WeRead-PC-<platform>-<arch>-<version>.zip
#   platform ∈ macOS | win32 | linux
set -euo pipefail

ROOT="$(pwd)"
APP_NAME="WeRead-PC"
VERSION=$(node -p "require('./package.json').version")
ELECTRON_VERSION=$(cat node_modules/electron/dist/version)
OUT_DIR="$ROOT/release"
CACHE_DIR="$ROOT/.electron-dist"
BUILD_DIR="$CACHE_DIR/build"
DL_BASE="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}"

TARGETS=("darwin-arm64")
if [ "${1:-}" = "--all" ]; then
  TARGETS=("darwin-arm64" "darwin-x64" "win32-x64" "linux-x64")
elif [ "${1:-}" = "--target" ]; then
  TARGETS=("${2:?--target 需要平台-架构，如 win32-x64}")
fi

echo "==> Electron v${ELECTRON_VERSION} · 应用 v${VERSION} · 目标: ${TARGETS[*]}"
mkdir -p "$OUT_DIR" "$CACHE_DIR" "$BUILD_DIR"

# 注入应用源码（主进程 require + index.html script 引用 + 图标资源）
inject_source() {
  local app_res="$1"
  rm -f "$app_res/default_app.asar"
  mkdir -p "$app_res/app"
  for f in "$ROOT"/*.js "$ROOT"/index.html "$ROOT"/package.json "$ROOT"/LICENSE; do
    [ -f "$f" ] && cp "$f" "$app_res/app/"
  done
  if [ -d "$ROOT/assets" ]; then
    mkdir -p "$app_res/app/assets"
    cp -R "$ROOT/assets/." "$app_res/app/assets/"
  fi
}

# 取得某平台运行时（解压到 work 根，含 Electron.app / electron.exe / electron）
obtain_runtime() {
  local target="$1" work="$2"
  if [ "$target" = "darwin-arm64" ] && [ -d "$ROOT/node_modules/electron/dist/Electron.app" ]; then
    echo "    复用本地 arm64 运行时"
    ditto "$ROOT/node_modules/electron/dist" "$work"
    return
  fi
  local zip="$CACHE_DIR/electron-v${ELECTRON_VERSION}-${target}.zip"
  if [ ! -f "$zip" ]; then
    echo "    下载 electron-v${ELECTRON_VERSION}-${target}.zip"
    curl -fL --retry 3 --max-time 600 -o "$zip" "${DL_BASE}/electron-v${ELECTRON_VERSION}-${target}.zip"
  fi
  echo "    解压运行时"
  unzip -q -o "$zip" -d "$work"
}

package_darwin() {
  local work="$1" arch="$2"
  local app="$work/$APP_NAME.app"
  mv "$work/Electron.app" "$app"
  inject_source "$app/Contents/Resources"
  [ -f "$app/Contents/MacOS/Electron" ] && mv "$app/Contents/MacOS/Electron" "$app/Contents/MacOS/$APP_NAME"
  if [ -f "$ROOT/assets/icons/WeRead-PC.icns" ]; then
    cp "$ROOT/assets/icons/WeRead-PC.icns" "$app/Contents/Resources/WeRead-PC.icns"
    cp "$ROOT/assets/icons/WeRead-PC.icns" "$app/Contents/Resources/electron.icns"
  fi
  local plist="$app/Contents/Info.plist"
  plutil -replace CFBundleName -string "WeRead PC" "$plist"
  plutil -replace CFBundleDisplayName -string "WeRead PC" "$plist"
  plutil -replace CFBundleIdentifier -string "com.happut.wereadpc" "$plist"
  plutil -replace CFBundleShortVersionString -string "$VERSION" "$plist"
  plutil -replace CFBundleVersion -string "$VERSION" "$plist"
  plutil -replace CFBundleExecutable -string "$APP_NAME" "$plist"
  [ -f "$ROOT/assets/icons/WeRead-PC.icns" ] && plutil -replace CFBundleIconFile -string "WeRead-PC.icns" "$plist"
  echo "    Ad-hoc 签名（未公证，首次打开需右键->打开）"
  codesign --force --deep --sign - "$app" >/dev/null 2>&1 || echo "    !! codesign 失败（跳过，本机仍可运行）"
  ( cd "$work" && ditto -c -k --sequesterRsrc --keepParent "$APP_NAME.app" "$OUT_DIR/$APP_NAME-macOS-${arch}-${VERSION}.zip" )
}

package_win32() {
  local work="$1" arch="$2" pkg="$BUILD_DIR/${target}-pkg"
  rm -rf "$pkg"; mkdir -p "$pkg/$APP_NAME"
  ( shopt -s dotglob; mv "$work"/* "$pkg/$APP_NAME"/ )
  local root="$pkg/$APP_NAME"
  inject_source "$root/resources"
  [ -f "$root/electron.exe" ] && mv "$root/electron.exe" "$root/$APP_NAME.exe"
  if command -v rcedit >/dev/null 2>&1 && [ -f "$ROOT/assets/icons/icon-b-cat-book-512.png" ]; then
    rcedit "$root/$APP_NAME.exe" --set-icon "$ROOT/assets/icons/icon-b-cat-book-512.png" >/dev/null 2>&1 || true
  fi
  ( cd "$pkg" && zip -q -r -y "$OUT_DIR/$APP_NAME-win32-${arch}-${VERSION}.zip" "$APP_NAME" )
}

package_linux() {
  local work="$1" arch="$2" pkg="$BUILD_DIR/${target}-pkg"
  rm -rf "$pkg"; mkdir -p "$pkg/$APP_NAME"
  ( shopt -s dotglob; mv "$work"/* "$pkg/$APP_NAME"/ )
  local root="$pkg/$APP_NAME"
  inject_source "$root/resources"
  [ -f "$root/electron" ] && mv "$root/electron" "$root/weread-pc"
  chmod +x "$root/weread-pc" || true
  if [ -f "$ROOT/assets/icons/icon-b-cat-book-512.png" ]; then
    cp "$ROOT/assets/icons/icon-b-cat-book-512.png" "$root/weread-pc.png"
    cat > "$root/weread-pc.desktop" <<EOF
[Desktop Entry]
Name=WeRead PC
Comment=微信读书桌面客户端
Exec=weread-pc --no-sandbox %U
Icon=weread-pc
Type=Application
Categories=Office;Reader;
Terminal=false
EOF
  fi
  ( cd "$pkg" && zip -q -r -y "$OUT_DIR/$APP_NAME-linux-${arch}-${VERSION}.zip" "$APP_NAME" )
}

for target in "${TARGETS[@]}"; do
  platform="${target%-*}"; arch="${target#*-}"
  echo "==> 构建 $target"
  work="$BUILD_DIR/$target"
  rm -rf "$work"; mkdir -p "$work"
  obtain_runtime "$target" "$work"
  case "$platform" in
    darwin) package_darwin "$work" "$arch" ;;
    win32)  package_win32  "$work" "$arch" ;;
    linux)  package_linux  "$work" "$arch" ;;
    *) echo "!! 未知平台 $platform" >&2; exit 1 ;;
  esac
  label="${platform/darwin/macOS}"
  echo "    完成: release/$APP_NAME-${label}-${arch}-${VERSION}.zip"
done

echo "==> 全部完成"
ls -lh "$OUT_DIR"/*"${VERSION}".zip