import Foundation
import AVFoundation
import Speech

@main
struct AppleTranscribe {
    static func main() async {
        guard CommandLine.arguments.count >= 4 else { exit(2) }
        let action = CommandLine.arguments[1]
        let model = CommandLine.arguments[2]
        let locale = Locale(identifier: CommandLine.arguments[3].replacingOccurrences(of: "-", with: "_"))
        do {
            if action == "probe" {
                let supported: [Locale]
                let installed: [Locale]
                if model == "apple-speech" {
                    supported = await SpeechTranscriber.supportedLocales
                    installed = await SpeechTranscriber.installedLocales
                } else if model == "apple-dictation" {
                    supported = await DictationTranscriber.supportedLocales
                    installed = await DictationTranscriber.installedLocales
                } else { exit(2) }
                let isSupported = supported.contains { $0.identifier == locale.identifier }
                let isInstalled = installed.contains { $0.identifier == locale.identifier }
                let available = isSupported && isInstalled &&
                    (model != "apple-speech" || SpeechTranscriber.isAvailable)
                try output(["available": available,
                            "reason": !isSupported ? "locale unsupported" :
                              !isInstalled ? "locale asset not installed" :
                              !available ? "SpeechTranscriber unavailable" : "ready"])
                return
            }
            if action == "install" {
                let modules: [any SpeechModule]
                if model == "apple-speech" {
                    modules = [SpeechTranscriber(locale: locale, preset: .transcription)]
                } else if model == "apple-dictation" {
                    modules = [DictationTranscriber(locale: locale, preset: .longDictation)]
                } else { exit(2) }
                if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                    try await request.downloadAndInstall()
                }
                try output(["installed": true])
                return
            }
            guard action == "transcribe", CommandLine.arguments.count == 5 else { exit(2) }
            let audio = try AVAudioFile(forReading: URL(fileURLWithPath: CommandLine.arguments[4]))
            let transcription: String
            if model == "apple-speech" {
                let module = SpeechTranscriber(locale: locale, preset: .transcription)
                let analyzer = SpeechAnalyzer(modules: [module])
                let collector = Task { () throws -> [String] in
                    var parts: [String] = []
                    for try await result in module.results { parts.append(String(result.text.characters)) }
                    return parts
                }
                _ = try await analyzer.analyzeSequence(from: audio)
                try await analyzer.finalizeAndFinishThroughEndOfInput()
                transcription = try await collector.value.joined(separator: " ")
            } else if model == "apple-dictation" {
                let module = DictationTranscriber(locale: locale, preset: .longDictation)
                let analyzer = SpeechAnalyzer(modules: [module])
                let collector = Task { () throws -> [String] in
                    var parts: [String] = []
                    for try await result in module.results { parts.append(String(result.text.characters)) }
                    return parts
                }
                _ = try await analyzer.analyzeSequence(from: audio)
                try await analyzer.finalizeAndFinishThroughEndOfInput()
                transcription = try await collector.value.joined(separator: " ")
            } else { exit(2) }
            try output(["text": transcription])
        } catch {
            fputs("Apple transcription failed: \(type(of: error))\n", stderr)
            exit(1)
        }
    }

    static func output(_ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        print(String(decoding: data, as: UTF8.self))
    }
}
