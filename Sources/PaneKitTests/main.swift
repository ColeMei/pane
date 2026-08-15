import Foundation

// The whole suite, run as an ordinary executable. See Harness.swift for why this is not XCTest.
runNoteFilenameTests()
runMarkdownDocumentTests()
runNoteOrderingTests()
runPanelGeometryTests()
runStateTests()
runVaultSyncTests()
runVaultIOTests()
runRecentlyDeletedTests()
runMarkdownExportTests()

exit(Check.finish())
