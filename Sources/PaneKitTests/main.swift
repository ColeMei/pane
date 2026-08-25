import Foundation

// The whole suite, run as an ordinary executable. See Harness.swift for why this is not XCTest.
runNoteFilenameTests()
runMarkdownDocumentTests()
runNoteTitleCorpusTests()
runNoteOrderingTests()
runPanelGeometryTests()
runPaneWidthTests()
runStateTests()
runSettingsTests()
runVaultSyncTests()
runVaultIOTests()
runRecentlyDeletedTests()
runMarkdownExportTests()
runAutoSizingTests()
runReleaseCheckTests()
runBuildProfileTests()

exit(Check.finish())
