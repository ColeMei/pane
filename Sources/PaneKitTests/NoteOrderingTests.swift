import Foundation
import PaneKit

/// Fixed clock so the bands are deterministic: 14 August 2026, 17:53 — the timestamp in the design's
/// own menu bar mock.
///
/// The mock labels that date "Thu"; it is actually a Friday. The weekday names below come from the
/// calendar, not from the mock.
private let utc = TimeZone(identifier: "UTC")!
private let english = Locale(identifier: "en_US")

private let calendar: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = utc
    c.locale = english
    return c
}()

private func at(_ iso: String) -> Date {
    let f = ISO8601DateFormatter()
    f.timeZone = utc
    return f.date(from: iso)!
}

private let now = at("2026-08-14T17:53:00Z")

private func band(_ iso: String, pinned: Bool = false) -> NoteOrdering.Band {
    NoteOrdering.band(modified: at(iso), isPinned: pinned, now: now, calendar: calendar)
}

private func label(_ iso: String, pinned: Bool = false) -> String {
    NoteOrdering.label(for: band(iso, pinned: pinned), calendar: calendar, locale: english)
}

private func time(_ iso: String) -> String {
    NoteOrdering.relativeTime(at(iso), now: now, calendar: calendar, locale: english)
}

func runNoteOrderingTests() {
    Check.suite("Switcher ordering") {

        Check.test("bands match the design's group headers") {
            Check.equal(label("2026-08-14T16:00:00Z"), "Today")
            Check.equal(label("2026-08-13T09:00:00Z"), "Yesterday")
            Check.equal(label("2026-08-11T09:00:00Z"), "This week")
            Check.equal(label("2026-08-10T09:00:00Z"), "This week")
            Check.equal(label("2026-07-28T09:00:00Z"), "July")
        }

        Check.test("a pin outranks its date") {
            // The design's pinned rows are from Jul 30 and Aug 2 yet sit above Today.
            Check.equal(label("2026-07-30T09:00:00Z", pinned: true), "Pinned")
            Check.equal(label("2026-08-14T17:00:00Z", pinned: true), "Pinned")
        }

        Check.test("older years carry the year in the header") {
            Check.equal(label("2025-05-12T09:00:00Z"), "May 2025")
        }

        Check.test("bands sort pinned first, then newest first") {
            let ordered: [NoteOrdering.Band] = [
                band("2026-07-30T09:00:00Z", pinned: true),
                band("2026-08-14T16:00:00Z"),
                band("2026-08-13T09:00:00Z"),
                band("2026-08-10T09:00:00Z"),
                band("2026-07-28T09:00:00Z"),
                band("2026-06-09T09:00:00Z"),
                band("2025-05-12T09:00:00Z"),
            ]
            let ranks = ordered.map(\.rank)
            Check.expect(ranks == ranks.sorted(), "expected ascending ranks, got \(ranks)")
        }

        Check.test("the boundary between yesterday and this week is a whole day, not 24 hours") {
            // 23:59 yesterday and 00:01 yesterday are both "Yesterday", however many hours ago.
            Check.equal(label("2026-08-13T23:59:00Z"), "Yesterday")
            Check.equal(label("2026-08-13T00:01:00Z"), "Yesterday")
            Check.equal(label("2026-08-14T00:01:00Z"), "Today")
        }

        Check.test("relative time tightens as a note gets older") {
            Check.equal(time("2026-08-14T17:52:45Z"), "now")
            Check.equal(time("2026-08-14T17:11:00Z"), "42m")
            Check.equal(time("2026-08-14T15:53:00Z"), "2h")
            Check.equal(time("2026-08-13T09:00:00Z"), "Thu")
            Check.equal(time("2026-08-10T09:00:00Z"), "Mon")
        }

        Check.test("a clock that runs backwards reads as now, not as a negative age") {
            // Sync daemons do set mtimes slightly in the future.
            Check.equal(time("2026-08-14T17:55:00Z"), "now")
        }

        Check.test("older notes fall back to a date, with the year only when it differs") {
            let sameYear = time("2026-07-30T09:00:00Z")
            Check.expect(sameYear.contains("Jul") && sameYear.contains("30"), "got \(sameYear)")
            Check.expect(!sameYear.contains("2026"), "same-year dates omit the year, got \(sameYear)")

            let otherYear = time("2025-05-12T09:00:00Z")
            Check.expect(otherYear.contains("May") && otherYear.contains("12"), "got \(otherYear)")
            Check.expect(otherYear.contains("2025"), "other-year dates carry it, got \(otherYear)")
        }

        Check.test("the grouping threshold matches the design's 'below ~8 notes, no headers'") {
            Check.equal(NoteOrdering.groupingThreshold, 8)
        }

        // ---- decision 104: which clock counts as "recent" ------------------------------------

        // The report: three notes last edited on 31 August carried a `lastOpened` of 1 September and
        // so sorted and read as today's. `.opened` stamps on every open, launch included.
        let edited = at("2026-08-31T09:00:00Z")
        let opened = at("2026-09-01T08:00:00Z")
        let named = "2026-08-11-1453-standup.md"

        Check.test("modified ignores lastOpened, which is the whole point of the default") {
            Check.equal(
                NoteOrdering.activity(
                    .modified, filename: named, modified: edited, lastOpened: opened, timeZone: utc
                ),
                edited
            )
        }

        Check.test("opened is the old behaviour, kept and named") {
            Check.equal(
                NoteOrdering.activity(
                    .opened, filename: named, modified: edited, lastOpened: opened, timeZone: utc
                ),
                opened
            )
            // An edit after the last open still wins: it is a max, not a preference for lastOpened.
            let editedLater = at("2026-09-02T10:00:00Z")
            Check.equal(
                NoteOrdering.activity(
                    .opened, filename: named, modified: editedLater, lastOpened: opened, timeZone: utc
                ),
                editedLater
            )
            // A note Pane has never opened has only its mtime.
            Check.equal(
                NoteOrdering.activity(
                    .opened, filename: named, modified: edited, lastOpened: nil, timeZone: utc
                ),
                edited
            )
        }

        Check.test("created reads the filename, not the file — decision 2 already froze it there") {
            var c = Calendar(identifier: .gregorian)
            c.timeZone = utc
            Check.equal(
                NoteOrdering.activity(
                    .created, filename: named, modified: edited, lastOpened: opened, timeZone: utc
                ),
                c.date(from: DateComponents(year: 2026, month: 8, day: 11, hour: 14, minute: 53))!
            )
        }

        Check.test("created falls back to the mtime for a hand-named file") {
            Check.equal(
                NoteOrdering.activity(
                    .created, filename: "shopping.md", modified: edited, lastOpened: opened,
                    timeZone: utc
                ),
                edited
            )
        }

        // Decision 45's rule, held per mode: whatever the mode picks is the value the band header
        // and the time column are both computed from, so a row can never sit under "Today" with a
        // date from August beside it.
        Check.test("the band and the time column agree in every mode") {
            let asOf = at("2026-09-01T12:00:00Z")
            for order in Settings.NoteOrder.allCases {
                let value = NoteOrdering.activity(
                    order, filename: named, modified: edited, lastOpened: opened, timeZone: utc
                )
                let bandIsToday = NoteOrdering.band(
                    modified: value, isPinned: false, now: asOf, calendar: calendar
                ) == .today
                let timeIsToday = NoteOrdering.relativeTime(
                    value, now: asOf, calendar: calendar, locale: english
                ).hasSuffix("h")
                Check.equal(bandIsToday, timeIsToday, "\(order.rawValue)")
            }
        }

        Check.test("the default is modified, because it is the only one sync preserves") {
            Check.equal(Settings().noteOrder, .modified)
        }
    }
}
