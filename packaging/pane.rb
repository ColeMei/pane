# Homebrew cask for Pane.
#
# This file is the source copy. The one Homebrew actually reads lives in the tap repo
# `ColeMei/homebrew-pane` as `Casks/pane.rb`; releasing copies this there with the version, url and
# sha256 updated. Keeping a copy here means the caveat text and the cask's shape are reviewed in the
# same pull request as the code they describe, instead of drifting in a repo nobody opens.
#
# The release workflow prints the sha256 in its job summary, so bumping is copy and paste.

cask "pane" do
  version "0.1.0"
  sha256 "REPLACE_WITH_RELEASE_ASSET_SHA256"

  url "https://github.com/ColeMei/pane/releases/download/v#{version}/Pane-#{version}.zip"
  name "Pane"
  desc "Hotkey-summoned notes panel backed by a folder of markdown files you own"
  homepage "https://github.com/ColeMei/pane"

  depends_on macos: ">= :sonoma"

  app "Pane.app"

  zap trash: [
    "~/Library/Application Support/Pane",
  ]

  # Deliberately NOT listing the vault. `zap` is for the app's own leavings, and the vault is the
  # user's documents — the entire premise of the product is that those files are theirs and outlive
  # the app. Uninstalling Pane must never be a way to lose them.

  caveats <<~EOS
    Pane is unsigned — there is no Apple Developer ID behind it.

    On recent macOS that means Gatekeeper reports the app as "damaged and can't be
    opened", and right-clicking → Open no longer gets past it. It is not damaged;
    that is simply what an unsigned app looks like now. Clear the quarantine flag
    once and it launches normally from then on:

      xattr -dr com.apple.quarantine /Applications/Pane.app

    Or skip the flag at install time:

      brew install --cask --no-quarantine ColeMei/pane/pane

    Pane requests no privacy permissions at all: the global hotkey goes through
    RegisterEventHotKey, which needs no Accessibility access, and no network code
    ships. Your notes are plain .md files in ~/Documents/Pane.
  EOS
end
