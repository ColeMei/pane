# The DMG window, for dmgbuild. Run through Scripts/make-dmg.sh, which passes `app` and `background`.
#
# dmgbuild writes the window's .DS_Store directly, so none of this drives Finder over AppleScript —
# the reason make-dmg.sh used to ship a bare window (it needs a GUI session and Automation consent
# that a CI runner does not reliably have).
#
# Coordinates are points from the top left of the window's content, and must match the art drawn by
# Scripts/make-dmg-background.py: the arrow there points from one of these icons to the other.

app = defines["app"]  # noqa: F821 — injected by dmgbuild

files = [app]
symlinks = {"Applications": "/Applications"}
hide_extensions = ["Pane.app"]

background = defines["background"]  # noqa: F821 — @2x beside it is picked up for Retina

# 640 x 428, the art's size. The art keeps everything in its top 400 points, so whether Finder counts
# the title bar inside these bounds or outside them, nothing that matters is cut off.
window_rect = ((200, 140), (640, 428))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

icon_size = 112
text_size = 13
icon_locations = {
    "Pane.app": (190, 205),
    "Applications": (450, 205),
}

format = "UDZO"
filesystem = "HFS+"
