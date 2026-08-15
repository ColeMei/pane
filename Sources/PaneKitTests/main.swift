import Foundation

// The whole suite, run as an ordinary executable. See Harness.swift for why this is not XCTest.
runNoteFilenameTests()
runMarkdownDocumentTests()

exit(Check.finish())
