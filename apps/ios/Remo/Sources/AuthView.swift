import SwiftUI

/// Sign-in / sign-up screen on the night background, matching Android's `AuthScreen`.
struct AuthView: View {
    @EnvironmentObject private var auth: AuthStore
    let onClose: () -> Void
    @State private var email = ""
    @State private var password = ""
    @State private var signUp = false
    @State private var showPassword = false
    @FocusState private var focusedField: Field?

    private enum Field { case email, password }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    IconButton(systemName: "xmark", label: "閉じる", tint: RemoStyle.onNight, action: onClose).offset(x: -12)
                    Spacer()
                }
                .frame(height: 56)

                HStack(spacing: 8) {
                    Image("AppMark")
                        .resizable()
                        .scaledToFill()
                        .scaleEffect(1.3)
                        .frame(width: 40, height: 40)
                        .clipShape(RoundedRectangle(cornerRadius: RemoRadius.medium, style: .continuous))
                    Text("remo").font(RemoFont.headline).foregroundStyle(RemoStyle.onNight)
                }
                .padding(.top, 8)

                Text("毎日を、静かに。\n自分のために。")
                    .font(RemoFont.display)
                    .foregroundStyle(RemoStyle.onNight)
                    .lineSpacing(4)
                    .padding(.top, 24)
                Text("位置と写真を1日の地図にまとめて、あとから眺められます。ログインすると記録がバックアップされ、Webや他の端末でも見られます。")
                    .font(RemoFont.bodyMedium)
                    .foregroundStyle(RemoStyle.onNightMuted)
                    .lineSpacing(4)
                    .padding(.top, 12)

                VStack(alignment: .leading, spacing: 16) {
                    ModeSegments(signUp: $signUp) { auth.errorMessage = nil }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(signUp ? "はじめましょう" : "おかえりなさい").font(RemoFont.headline).foregroundStyle(RemoStyle.ink)
                        Text(signUp ? "メールアドレスとパスワードで登録します。" : "登録したメールアドレスでログインします。")
                            .font(RemoFont.bodyMedium).foregroundStyle(RemoStyle.inkSecondary)
                    }
                    AuthField(icon: "envelope", label: "メールアドレス", focused: focusedField == .email) {
                        TextField("", text: $email, prompt: Text("メールアドレス").foregroundStyle(RemoStyle.inkSecondary))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.emailAddress)
                            .textContentType(.username)
                            .focused($focusedField, equals: .email)
                            .submitLabel(.next)
                            .onSubmit { focusedField = .password }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        AuthField(icon: "lock", label: "パスワード", focused: focusedField == .password) {
                            Group {
                                if showPassword { TextField("", text: $password, prompt: Text("パスワード").foregroundStyle(RemoStyle.inkSecondary)) }
                                else { SecureField("", text: $password, prompt: Text("パスワード").foregroundStyle(RemoStyle.inkSecondary)) }
                            }
                            .textContentType(signUp ? .newPassword : .password)
                            .focused($focusedField, equals: .password)
                            .submitLabel(.done)
                            .onSubmit(submit)
                            Button { showPassword.toggle() } label: {
                                Image(systemName: showPassword ? "eye.slash" : "eye").font(.system(size: 17)).foregroundStyle(RemoStyle.inkSecondary).frame(width: 40, height: 40)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(showPassword ? "パスワードを隠す" : "パスワードを表示")
                        }
                        if signUp {
                            Text("8文字以上").font(RemoFont.bodySmall).foregroundStyle(RemoStyle.inkSecondary).padding(.leading, 16)
                        }
                    }
                    if let error = auth.errorMessage {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.circle").font(.system(size: 16)).foregroundStyle(RemoStyle.danger).frame(width: 20, height: 20)
                            Text(error).font(RemoFont.bodySmall).foregroundStyle(RemoStyle.danger).padding(.top, 2)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(RemoStyle.dangerContainer, in: RoundedRectangle(cornerRadius: RemoRadius.medium, style: .continuous))
                    }
                    Button(action: submit) {
                        if auth.isSubmitting { ProgressView().tint(.white) } else { Text(signUp ? "アカウントを作成" : "ログイン") }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(auth.isSubmitting)
                }
                .padding(20)
                .background(RemoStyle.surface, in: RoundedRectangle(cornerRadius: RemoRadius.extraLarge, style: .continuous))
                .padding(.top, 24)

                Button("ログインせずに使う", action: onClose)
                    .buttonStyle(TextActionStyle(color: RemoStyle.onNightMuted))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
            }
            .frame(maxWidth: 520)
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(RemoStyle.night.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private func submit() {
        focusedField = nil
        Task { await auth.authenticate(email: email, password: password, signUp: signUp) }
    }
}

private struct ModeSegments: View {
    @Binding var signUp: Bool
    let onChange: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            segment("ログイン", value: false)
            Rectangle().fill(RemoStyle.outlineStrong).frame(width: 1)
            segment("新規登録", value: true)
        }
        .frame(height: 40)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(RemoStyle.outlineStrong, lineWidth: 1))
    }

    private func segment(_ title: String, value: Bool) -> some View {
        Button {
            guard signUp != value else { return }
            signUp = value
            onChange()
        } label: {
            Text(title)
                .font(RemoFont.labelLarge)
                .foregroundStyle(signUp == value ? RemoStyle.onGreenContainer : RemoStyle.inkSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(signUp == value ? RemoStyle.greenContainer : RemoStyle.surface)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(signUp == value ? .isSelected : [])
    }
}

/// 56pt outlined field with a leading icon; the outline turns green while focused.
private struct AuthField<Content: View>: View {
    let icon: String
    let label: String
    let focused: Bool
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 18)).foregroundStyle(focused ? RemoStyle.green : RemoStyle.inkSecondary).frame(width: 24)
            content
        }
        .font(RemoFont.bodyLarge)
        .foregroundStyle(RemoStyle.ink)
        .tint(RemoStyle.green)
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .frame(height: 56)
        .background(RemoStyle.surface, in: RoundedRectangle(cornerRadius: RemoRadius.medium, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: RemoRadius.medium, style: .continuous).stroke(focused ? RemoStyle.green : RemoStyle.outlineStrong, lineWidth: focused ? 2 : 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}
