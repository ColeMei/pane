# Homebrew cask for Pane.
#
# This file is the source copy. The one Homebrew actually reads lives in the tap repo
# `ColeMei/homebrew-pane` as `Casks/pane.rb`. Keeping a copy here means the caveat text and the
# cask's shape are reviewed in the same pull request as the code they describe, instead of drifting
# in a repo nobody opens.
#
# Publishing a release runs `.github/workflows/cask.yml`, which writes the new version and sha256
# into this file, copies it to the tap, and commits it back to dev. Edit anything here except those
# two lines; the next release carries the edit to the tap.

cask "pane" do
  version "0.7.2"
  sha256 "2e02341e2fdc23153c077f6b9e2481f08730edad9ef0543a4bc2db138041d2e4"

  url "https://github.com/ColeMei/pane/releases/download/v#{version}/Pane-#{version}.dmg"
  name "Pane"
  desc "Hotkey-summoned notes panel backed by a folder of markdown files you own"
  homepage "https://github.com/ColeMei/pane"

  depends_on macos: :sonoma
  # Pane installs its own updates (Sparkle), so `brew upgrade` leaves it alone unless --greedy.
  auto_updates true

  app "Pane.app"

  # Enumerated rather than trashing the whole support directory, because it is no longer only the
  # app's own leavings. Decision 35 put "Recently Deleted" in there — up to 30 days of notes the user
  # deleted and can still get back — so `--zap` would have swept away recoverable documents as a side
  # effect of uninstalling. Anything added here later has to answer the same question: is it Pane's,
  # or is it the user's?
  zap trash: [
    "~/Library/Application Support/Pane/settings.json",
    "~/Library/Application Support/Pane/state.json",
    "~/Library/Application Support/Pane/Themes",
  ]

  # Deliberately NOT listing the vault, and no longer the Recently Deleted folder either. `zap` is
  # for the app's own leavings, and both of those are the user's documents — the entire premise of
  # the product is that those files are theirs and outlive the app. Uninstalling Pane must never be
  # a way to lose them.

  caveats <<~EOS
    Pane is unsigned — there is no Apple Developer ID behind it.

    On recent macOS that means Gatekeeper reports the app as "damaged and can't be
    opened", and right-clicking → Open no longer gets past it. It is not damaged;
    that is simply what an unsigned app looks like now. Clear the quarantine flag
    after each install or upgrade and it launches normally:

      xattr -dr com.apple.quarantine /Applications/Pane.app

    Pane requests no privacy permissions at all: the global hotkey goes through
    RegisterEventHotKey, which needs no Accessibility access. The only request it
    ever makes to the network is asking GitHub whether a newer release exists --
    when you press the button under Settings > About, and once a day when you
    summon the pane -- and it sends nothing about you. Switch the daily one off
    under Settings > General. An update is downloaded and installed only when you
    choose "Update to ..." from the menu bar item, and only if it carries the
    project's update signature. Your notes are plain .md files in ~/Documents/Pane.
  EOS
end
