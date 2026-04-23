cask "claude-cat-monitor" do
  version "0.3.5"
  sha256 "242d595f6919b98411778dbeb67ea20d28b4a0328036906a1e3770eede39e78d"

  url "https://github.com/huangken8511429/claude-cat-island/releases/download/v#{version}/Claude.Cat.Monitor_#{version}_aarch64.zip"
  name "Claude Cat Monitor"
  desc "Pixel-art cat dashboard for monitoring Claude Code sessions"
  homepage "https://github.com/huangken8511429/claude-cat-island"

  depends_on macos: ">= :ventura"
  depends_on arch: :arm64

  app "Claude Cat Monitor.app"

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-cr", "#{appdir}/Claude Cat Monitor.app"],
                   sudo: false
  end

  zap trash: [
    "~/.claude-cat-monitor",
  ]
end
