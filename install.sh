#!/bin/bash
set -euo pipefail

APP_NAME="Claude Cat Monitor"
REPO="huangken8511429/claude-cat-island"
INSTALL_DIR="/Applications"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC}  $1"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $1"; }
fail()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

# ── Pre-checks ──
[[ "$(uname)" == "Darwin" ]] || fail "This app only supports macOS."

ARCH="$(uname -m)"
[[ "$ARCH" == "arm64" ]] || fail "This build requires Apple Silicon (arm64). Got: $ARCH"

command -v curl >/dev/null || fail "curl is required but not found."

# ── Fetch latest release ──
info "Fetching latest release from GitHub..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
TAG=$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*: "//;s/".*//')
DMG_URL=$(echo "$RELEASE_JSON" | grep '"browser_download_url"' | grep '\.dmg"' | head -1 | sed 's/.*: "//;s/".*//')

[[ -n "$TAG" ]]     || fail "Could not determine latest release tag."
[[ -n "$DMG_URL" ]] || fail "Could not find .dmg asset in release ${TAG}."

info "Latest version: ${TAG}"

# ── Download ──
TMPDIR_PATH=$(mktemp -d)
DMG_PATH="${TMPDIR_PATH}/${APP_NAME}.dmg"
trap 'rm -rf "$TMPDIR_PATH"' EXIT

info "Downloading ${DMG_URL##*/}..."
curl -fSL --progress-bar -o "$DMG_PATH" "$DMG_URL"
ok "Download complete."

# ── Mount & Install ──
info "Mounting disk image..."
MOUNT_OUTPUT=$(hdiutil attach "$DMG_PATH" -nobrowse 2>&1) || fail "hdiutil attach failed:\n${MOUNT_OUTPUT}"
MOUNT_POINT=$(echo "$MOUNT_OUTPUT" | grep '/Volumes/' | sed 's/.*\(\/Volumes\/.*\)/\1/' | head -1 | xargs)
[[ -d "$MOUNT_POINT" ]] || fail "Failed to find mount point. hdiutil output:\n${MOUNT_OUTPUT}"

SRC_APP="${MOUNT_POINT}/${APP_NAME}.app"
[[ -d "$SRC_APP" ]] || fail "App not found in DMG at: ${SRC_APP}"

DEST_APP="${INSTALL_DIR}/${APP_NAME}.app"
if [[ -d "$DEST_APP" ]]; then
    warn "Removing previous installation..."
    rm -rf "$DEST_APP"
fi

info "Installing to ${INSTALL_DIR}..."
cp -R "$SRC_APP" "$INSTALL_DIR/"
ok "Installed ${APP_NAME}.app"

# ── Remove quarantine ──
info "Removing macOS quarantine attribute..."
xattr -cr "$DEST_APP"
ok "Quarantine cleared."

# ── Unmount ──
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true

# ── Done ──
echo ""
echo -e "${GREEN}✅ ${APP_NAME} ${TAG} installed successfully!${NC}"
echo ""
echo "  Launch:  open -a '${APP_NAME}'"
echo "  Debug:   \"${DEST_APP}/Contents/MacOS/claude-cat-monitor\""
echo ""

# ── Ask to launch ──
read -rp "Launch now? [Y/n] " answer
answer=${answer:-Y}
if [[ "$answer" =~ ^[Yy]$ ]]; then
    open -a "$APP_NAME"
    ok "Launched!"
fi
