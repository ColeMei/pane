#!/usr/bin/env bash
# The gesture replay: every key cell of the October 2026 sweep, against Typora's results.
#
# `Editor/tests/gestures.golden.json` is what each cell should end as; this puts it in front of the
# suite as `GOLDEN` (the probe loads a suite as one data: URL module, so it cannot read a file) and
# runs it in the real bundle. A red row is a gesture that ends where Typora's does not, and that
# nobody has decided to keep. Pass a golden file as the second argument to replay another.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--skip-editor" ]]; then
	echo "==> Building the editor bundle"
	(cd Editor && node build.mjs >/dev/null)
fi
golden="${2:-Editor/tests/gestures.golden.json}"

# The probe reports once, at the end, so the cells run in slices of 3,000 with a line after each.
dir="$(mktemp -d)"
total=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['cells']))" "$golden")
echo "==> Replaying the gesture sweep: $total cells"
status=0; checked=0; failed=0
for ((lo = 0; lo < total; lo += 3000)); do
	hi=$((lo + 3000 < total ? lo + 3000 : total))
	{ printf 'const GOLDEN = '; cat "$golden"; printf ';\nconst RANGE = [%d, %d];\n' "$lo" "$hi"; cat Editor/tests/gestures.test.js; } > "$dir/gestures.test.js"
	PROBE_TIMEOUT=600 swift Scripts/editor-probe.swift "$PWD/Editor/dist/index.html" "$dir/gestures.test.js" > "$dir/out.txt" || status=1
	grep -v '^✓' "$dir/out.txt" | grep -v ' assertions diverged$' || true
	n=$(grep -c '^✗ ' "$dir/out.txt" || true)
	failed=$((failed + n)); checked=$hi
	echo "    $hi of $total cells, $failed red so far"
done
[[ $failed -eq 0 ]] && echo "✓ $total gesture cells, all as the sweep expects" || echo "✗ $failed of $total gesture cells diverge"
exit $status
