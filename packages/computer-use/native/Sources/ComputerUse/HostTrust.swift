import Darwin
import Foundation
import Security

/// mcp-embedded trusts its stdin peer to control sessions, so the mode
/// selector alone is not authentication: a team-signed helper only serves the
/// OpenWork desktop app itself. Other code the team signs, such as the bundled
/// sidecars, is not a host. After the responsibility relaunch the parent is
/// this helper's own first process, which already checked the desktop.
enum HostTrust {
    /// The appId of every signed desktop distribution. Demo builds are unsigned.
    static let desktopIdentifier = "com.differentai.openwork"

    /// A fork may pin its host in the helper's signed bundle, never in runtime env.
    static func configuredDesktopIdentifier(_ info: [String: Any]) -> String? {
        guard let configured = info["OpenWorkTrustedHostIdentifier"] else { return desktopIdentifier }
        guard let identifier = configured as? String,
              identifier.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$", options: .regularExpression) != nil else { return nil }
        return identifier
    }

    static func isHostApplication(_ identifier: String, info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> Bool {
        guard let host = configuredDesktopIdentifier(info) else { return true }
        return identifier == host || identifier.hasPrefix(host + ".")
    }

    static func embeddedHostIsTrusted() -> Bool {
        guard let signer = signingIdentity() else {
            // An unsigned helper cannot authenticate its host. Both MCP modes
            // require a signed peer; standalone mode is no bypass.
            return false
        }
        guard let configuredHost = configuredDesktopIdentifier(Bundle.main.infoDictionary ?? [:]) else { return false }
        let host = Responsibility.relaunched ? signer.identifier : configuredHost
        return process(getppid(), isSignedAs: host, team: signer.team)
    }

    static func process(_ pid: pid_t, isSignedAs identifier: String, team: String) -> Bool {
        guard team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil,
              identifier.range(of: "^[A-Za-z0-9.-]+$", options: .regularExpression) != nil,
              pid > 1 else { return false }
        var guest: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &guest) == errSecSuccess,
              let guest else { return false }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString("identifier \"\(identifier)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\"" as CFString, [], &requirement) == errSecSuccess,
              let requirement else { return false }
        return SecCodeCheckValidity(guest, [], requirement) == errSecSuccess
    }

    private static func signingIdentity() -> (team: String, identifier: String)? {
        var current: SecCode?
        var code: SecStaticCode?
        var info: CFDictionary?
        guard SecCodeCopySelf([], &current) == errSecSuccess, let current,
              SecCodeCopyStaticCode(current, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, [], nil) == errSecSuccess,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let values = info as? [String: Any],
              let team = values[kSecCodeInfoTeamIdentifier as String] as? String,
              let identifier = values[kSecCodeInfoIdentifier as String] as? String else { return nil }
        return (team, identifier)
    }
}
