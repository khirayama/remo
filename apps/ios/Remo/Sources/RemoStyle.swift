import SwiftUI
import UIKit

/// Design tokens mirrored from Android's `AppColors` (the source of truth).
/// Deep forest green carries the brand; the mint from the launcher mark is
/// reserved for small "live" accents. Movement, stays and photos each own one
/// hue so the map and the timeline read the same way.
enum RemoStyle {
    static let background = Color(light: 0xF4F5F1, dark: 0x0F1512)
    static let surface = Color(light: 0xFFFFFF, dark: 0x18201C)
    static let surfaceMuted = Color(light: 0xF0F2EE, dark: 0x222C27)
    static let outline = Color(light: 0xE2E7E1, dark: 0x2C3832)
    static let outlineStrong = Color(light: 0xC9D2C9, dark: 0x46564D)

    static let ink = Color(light: 0x14291F, dark: 0xE6ECE7)
    static let inkSecondary = Color(light: 0x55635A, dark: 0xB6C1B9)
    static let inkTertiary = Color(light: 0x7E8A82, dark: 0x8D9A91)

    static let green = Color(light: 0x2F5A45, dark: 0x86D3A9)
    /// Text and icons on a `green` fill.
    static let onGreen = Color(light: 0xFFFFFF, dark: 0x0F2A1D)
    static let greenContainer = Color(light: 0xDFECE2, dark: 0x264536)
    static let onGreenContainer = Color(light: 0x16352A, dark: 0xCFE9D8)
    static let mint = Color(hex: 0x1FCFA8)

    static let teal = Color(light: 0x0E8577, dark: 0x58CBB9)
    static let tealDark = Color(light: 0x085E54, dark: 0xA0EBDE)
    static let tealContainer = Color(light: 0xD9F0EB, dark: 0x173F39)
    static let amber = Color(light: 0x9E6A2C, dark: 0xE3B578)
    static let amberContainer = Color(light: 0xF5EADB, dark: 0x47361E)

    static let danger = Color(light: 0xB3261E, dark: 0xF2B8B5)
    static let dangerContainer = Color(light: 0xFBEAE8, dark: 0x5C2420)

    // The sign-in hero is dark in both appearances.
    static let night = Color(light: 0x10261D, dark: 0x0B1410)
    static let onNight = Color(hex: 0xF2F5F0)
    static let onNightMuted = Color(hex: 0xF2F5F0).opacity(0.7)
}

/// Colors drawn on the map. They follow the appearance like the rest of the
/// app: lighter marks keep their contrast on the dark map.
enum RemoMapColor {
    static let route = UIColor(light: 0x0E8577, dark: 0x58CBB9)
    static let focusRoute = UIColor(light: 0x085E54, dark: 0xA0EBDE)
    static let stay = UIColor(light: 0x2F5A45, dark: 0x86D3A9)
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    /// A color that follows the system appearance.
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor(light: light, dark: dark))
    }
}

extension UIColor {
    /// A color that follows the system appearance.
    convenience init(light: UInt32, dark: UInt32) {
        self.init { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) }
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}

/// Type scale matching Android's `RemoTypography` (sp → pt). Everything is set
/// in the system gothic (sans) face; headings get their hierarchy from weight.
enum RemoFont {
    static let display = Font.system(size: 30, weight: .bold)
    static let headline = Font.system(size: 22, weight: .bold)
    static let title = Font.system(size: 20, weight: .bold)
    static let titleMedium = Font.system(size: 16, weight: .semibold)
    static let dialogTitle = Font.system(size: 18, weight: .semibold)
    static let titleSmall = Font.system(size: 15, weight: .semibold)
    static let bodyLarge = Font.system(size: 16)
    static let bodyMedium = Font.system(size: 14)
    static let bodySmall = Font.system(size: 12)
    static let labelLarge = Font.system(size: 14, weight: .medium)
    static let labelMedium = Font.system(size: 12, weight: .medium)
    static let labelSmall = Font.system(size: 11, weight: .medium)
}

/// Corner radii matching Android's `RemoShapes`.
enum RemoRadius {
    static let extraSmall: CGFloat = 6
    static let small: CGFloat = 8
    static let medium: CGFloat = 12
    static let large: CGFloat = 16
    static let extraLarge: CGFloat = 28
}

// MARK: - Shared components

/// Circular tinted badge used for timeline kinds, settings and empty states.
struct IconBadge: View {
    let systemName: String
    let tint: Color
    let container: Color
    var size: CGFloat = 32
    var iconSize: CGFloat = 18

    var body: some View {
        RemoGlyph(name: systemName, size: iconSize)
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(container, in: Circle())
    }
}

/// Glyphs Android draws from Material icons that SF Symbols lacks an equivalent for.
enum RemoGlyphName {
    static let place = "remo.place"
}

/// An icon at a Material-like optical size: SF Symbols, or a bundled Material glyph.
struct RemoGlyph: View {
    let name: String
    let size: CGFloat
    var weight: Font.Weight = .medium

    var body: some View {
        if name == RemoGlyphName.place {
            Image("Place").renderingMode(.template).resizable().scaledToFit().frame(width: size, height: size)
        } else {
            Image(systemName: name).font(.system(size: size * 0.84, weight: weight)).frame(width: size, height: size)
        }
    }
}

/// 48pt floating control drawn on top of the map.
struct MapControlButton: View {
    let systemName: String
    let label: String
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(RemoStyle.ink)
                .frame(width: 48, height: 48)
                .background(RemoStyle.surface, in: Circle())
                .shadow(color: .black.opacity(0.18), radius: 3, y: 1.5)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.6)
        .accessibilityLabel(label)
    }
}

/// 36×4 grab bar with 10/6pt breathing room.
struct SheetHandle: View {
    var body: some View {
        Capsule()
            .fill(RemoStyle.outlineStrong)
            .frame(width: 36, height: 4)
            .frame(maxWidth: .infinity)
            .padding(.top, 10)
            .padding(.bottom, 6)
    }
}

struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(RemoFont.labelLarge).foregroundStyle(RemoStyle.inkSecondary)
    }
}

/// A 56pt list row: 24pt icon, title and optional subtitle, optional trailing view.
struct ActionRow<Trailing: View>: View {
    let systemName: String
    let title: String
    var tint: Color = RemoStyle.green
    var subtitle: String?
    var action: (() -> Void)?
    @ViewBuilder var trailing: Trailing

    var body: some View {
        let content = HStack(spacing: 16) {
            RemoGlyph(name: systemName, size: 24, weight: .regular)
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(RemoFont.bodyLarge).foregroundStyle(tint == RemoStyle.danger ? RemoStyle.danger : RemoStyle.ink)
                if let subtitle {
                    Text(subtitle).font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkSecondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(minHeight: 56)
        .contentShape(Rectangle())

        if let action {
            Button(action: action) { content }.buttonStyle(RowButtonStyle())
        } else {
            content
        }
    }
}

extension ActionRow where Trailing == EmptyView {
    init(systemName: String, title: String, tint: Color = RemoStyle.green, subtitle: String? = nil, action: (() -> Void)?) {
        self.init(systemName: systemName, title: title, tint: tint, subtitle: subtitle, action: action) { EmptyView() }
    }
}

/// Pressed state for full-width rows, like a Material ripple.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? RemoStyle.ink.opacity(0.06) : .clear)
    }
}

/// Divider inset to the text column of an `ActionRow`.
struct GroupDivider: View {
    var body: some View {
        Rectangle().fill(RemoStyle.outline).frame(height: 1).padding(.leading, 56)
    }
}

struct RowChevron: View {
    var body: some View {
        Image(systemName: "chevron.right").font(.system(size: 14, weight: .medium)).foregroundStyle(RemoStyle.inkTertiary).frame(width: 20)
    }
}

/// Filled 48pt primary button.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(RemoFont.labelLarge)
            .foregroundStyle(isEnabled ? RemoStyle.onGreen : RemoStyle.ink.opacity(0.38))
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(isEnabled ? RemoStyle.green : RemoStyle.ink.opacity(0.12), in: Capsule())
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// Text-only button, Material `TextButton`.
struct TextActionStyle: ButtonStyle {
    var color: Color = RemoStyle.green
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(RemoFont.labelLarge)
            .foregroundStyle(isEnabled ? color : RemoStyle.inkTertiary)
            .padding(.horizontal, 12)
            .frame(minHeight: 40)
            .background(configuration.isPressed ? color.opacity(0.1) : .clear, in: Capsule())
            .contentShape(Capsule())
    }
}

/// 48pt round icon button without a container (Material `IconButton`).
struct IconButton: View {
    let systemName: String
    let label: String
    var tint: Color = RemoStyle.ink
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(enabled ? tint : RemoStyle.outlineStrong)
                .frame(width: 48, height: 48)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
    }
}

/// Transient message pinned to the bottom of the screen, like a Material snackbar.
struct Snackbar: View {
    let message: String
    var body: some View {
        Text(message)
            .font(RemoFont.bodyMedium)
            .foregroundStyle(RemoStyle.onNight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(RemoStyle.ink, in: RoundedRectangle(cornerRadius: RemoRadius.medium, style: .continuous))
            .shadow(color: .black.opacity(0.18), radius: 6, y: 3)
            .padding(16)
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// Graphical date picker bound to the app's day values. Future days cannot be chosen.
struct RemoDatePickerSheet: View {
    let initial: Date
    let onConfirm: (Date) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var value: Date

    init(initial: Date, onConfirm: @escaping (Date) -> Void) {
        self.initial = initial
        self.onConfirm = onConfirm
        _value = State(initialValue: initial)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("日付を選択").font(RemoFont.labelLarge).foregroundStyle(RemoStyle.inkSecondary).padding(.horizontal, 24).padding(.top, 24)
            Text(formatDate(value)).font(RemoFont.headline).foregroundStyle(RemoStyle.ink).padding(.horizontal, 24).padding(.top, 8)
            DatePicker("日付", selection: $value, in: ...Date(), displayedComponents: .date)
                .datePickerStyle(.graphical)
                .labelsHidden()
                .tint(RemoStyle.green)
                .environment(\.locale, RemoFormat.locale)
                .environment(\.calendar, RemoFormat.calendar)
                .padding(.horizontal, 12)
            HStack(spacing: 8) {
                Spacer()
                Button("キャンセル") { dismiss() }.buttonStyle(TextActionStyle())
                Button("決定") { onConfirm(RemoFormat.calendar.startOfDay(for: value)); dismiss() }.buttonStyle(TextActionStyle())
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
        }
        .background(RemoStyle.surface)
        .presentationDetents([.height(560)])
        .presentationCornerRadius(RemoRadius.extraLarge)
        .presentationBackground(RemoStyle.surface)
    }
}

// MARK: - Formatting (Japanese, matching Android's formatters)

enum RemoFormat {
    static let locale = Locale(identifier: "ja_JP")
    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = locale
        calendar.timeZone = .current
        return calendar
    }()

    static func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        formatter.timeZone = .current
        formatter.dateFormat = format
        return formatter
    }

    static let dayTitle = formatter("M月d日（E）")
    static let date = formatter("yyyy年M月d日（E）")
    static let time = formatter("HH:mm")
    static let dayTime = formatter("M月d日（E） HH:mm")
    static let dateTime = formatter("yyyy年M月d日 HH:mm")
    static let backup = formatter("M月d日 HH:mm")
}

/// "9月1日（火）"
func formatDayTitle(_ date: Date) -> String { RemoFormat.dayTitle.string(from: date) }
/// "2026年9月1日（火）"
func formatDate(_ date: Date) -> String { RemoFormat.date.string(from: date) }
func formatTime(_ date: Date) -> String { RemoFormat.time.string(from: date) }
func formatDayTime(_ date: Date) -> String { RemoFormat.dayTime.string(from: date) }
func formatDateTime(_ date: Date) -> String { RemoFormat.dateTime.string(from: date) }
func formatBackupTime(_ date: Date) -> String { RemoFormat.backup.string(from: date) }

/// "2026年 · 今日" — the year plus a relative hint for recent days.
func formatDaySubtitle(_ date: Date, now: Date = Date()) -> String {
    let calendar = RemoFormat.calendar
    let year = "\(calendar.component(.year, from: date))年"
    if calendar.isDate(date, inSameDayAs: now) { return "\(year) · 今日" }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "\(year) · 昨日" }
    return year
}

func activityDurationLabel(_ duration: TimeInterval) -> String {
    if duration < 60 { return "1分未満" }
    let minutes = Int(duration / 60)
    let hours = minutes / 60
    let remainder = minutes % 60
    return hours > 0 ? "\(hours)時間\(remainder > 0 ? "\(remainder)分" : "")" : "\(minutes)分"
}

func formatDistance(_ distance: Double?) -> String {
    guard let distance, distance.isFinite else { return "距離不明" }
    return distance < 1_000 ? "\(Int(distance)) m" : String(format: "%.1f km", distance / 1_000)
}

func mediaCountLabel(_ log: LogEntry) -> String {
    log.mediaType == .video ? "動画 \(log.photoCount)本" : "写真 \(log.photoCount)枚"
}

func mediaSummary(photoCount: Int, videoCount: Int) -> String {
    let summary = [photoCount > 0 ? "写真 \(photoCount)枚" : nil, videoCount > 0 ? "動画 \(videoCount)本" : nil].compactMap { $0 }.joined(separator: " · ")
    return summary.isEmpty ? "メディアなし" : summary
}

func mediaSummary(_ logs: [LogEntry]) -> String {
    mediaSummary(
        photoCount: logs.filter { $0.mediaType != .video }.reduce(0) { $0 + $1.photoCount },
        videoCount: logs.filter { $0.mediaType == .video }.reduce(0) { $0 + $1.photoCount },
    )
}

func formatCoordinates(_ log: LogEntry) -> String { formatCoordinates(latitude: log.latitude, longitude: log.longitude) }
func formatCoordinates(latitude: Double?, longitude: Double?) -> String {
    guard hasUsableCoordinates(latitude, longitude), let latitude, let longitude else { return "位置情報なし" }
    return String(format: "%.5f, %.5f", latitude, longitude)
}
