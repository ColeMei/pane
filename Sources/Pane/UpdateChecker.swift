import Foundation
import PaneKit

/// The one network call Pane makes, in one place.
///
/// It was inline in the About tab while the About button was the only caller. The summon check is
/// the second caller, and two copies of a request would be two User-Agent strings, two timeouts and
/// two ways to parse the same JSON — the shape of fault decision 74 keeps finding, one file over.
///
/// What it does **not** do is unchanged from decision 94, and the list is the promise: it does not
/// download, install, or open anything, it sends nothing about the machine, and it never fires on
/// its own. Both callers are a press or a keypress.
enum UpdateChecker {

    static let releasesAPI = URL(string: "https://api.github.com/repos/ColeMei/pane/releases/latest")!
    static let releasesPage = URL(string: "https://github.com/ColeMei/pane/releases")!

    /// `CFBundleShortVersionString`, which `build-app.sh` writes from the tag.
    static var runningVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
    }

    /// Asks GitHub for the latest tag and compares it with the running build.
    ///
    /// `.unknown` covers every way this can fail — no network, a rate limit, a captive portal
    /// answering with a login page — because none of them is something the reader can act on
    /// differently (decision 76). The caller decides whether silence or a sentence is right:
    /// the About button says so, the summon check says nothing at all.
    static func fetchStatus(completion: @escaping @Sendable (ReleaseCheck.Status) -> Void) {
        var request = URLRequest(url: releasesAPI)
        request.timeoutInterval = 10
        // GitHub's API refuses a request with no User-Agent. It carries the version rather than
        // anything about the machine, because the version is the only thing the request is about.
        request.setValue("Pane/\(runningVersion)", forHTTPHeaderField: "User-Agent")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")

        let current = runningVersion
        URLSession.shared.dataTask(with: request) { data, _, error in
            let tag = data.flatMap {
                (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any]
            }?["tag_name"] as? String

            guard error == nil, let tag else {
                completion(.unknown)
                return
            }
            completion(ReleaseCheck.status(current: current, latest: tag))
        }.resume()
    }
}
