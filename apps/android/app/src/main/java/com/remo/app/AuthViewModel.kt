package com.remo.app

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class AuthUiState(
    val initialized: Boolean = false,
    val signedIn: Boolean = false,
    val user: RemoUser? = null,
    val signUp: Boolean = false,
    val email: String = "",
    val password: String = "",
    val isSubmitting: Boolean = false,
    val error: String? = null,
)

class AuthViewModel : ViewModel() {
    private val mutableState = MutableStateFlow(AuthUiState())
    val state = mutableState.asStateFlow()

    init {
        viewModelScope.launch(Dispatchers.IO) {
            val user = if (SecureTokenStore.get() == null) null else try {
                ApiClient.currentUser()
            } catch (error: Exception) {
                // Only the server rejecting the session signs the user out. Starting
                // offline (or during an outage) keeps the session and its backup.
                if (isSessionRejected(error)) null else SecureTokenStore.cachedAccount()
            }
            if (user == null) {
                SecureTokenStore.clear()
                SecureTokenStore.clearAccountId()
            } else {
                SecureTokenStore.setAccount(user)
            }
            mutableState.update { it.copy(initialized = true, signedIn = user != null, user = user) }
        }
    }

    /** The server no longer accepts the stored session: sign out and ask to log in again. */
    fun sessionExpired() {
        viewModelScope.launch {
            withContext(Dispatchers.IO) { SecureTokenStore.clear() }
            SecureTokenStore.clearAccountId()
            BackupCoordinator.resetSession()
            mutableState.value = AuthUiState(initialized = true)
        }
    }

    fun setEmail(value: String) = mutableState.update { it.copy(email = value, error = null) }
    fun setPassword(value: String) = mutableState.update { it.copy(password = value, error = null) }
    fun toggleMode() = mutableState.update { it.copy(signUp = !it.signUp, error = null) }

    fun submit() {
        val current = state.value
        if (current.email.isBlank() || current.password.length < 8) {
            mutableState.update { it.copy(error = if (current.email.isBlank()) "メールアドレスを入力してください" else "パスワードは8文字以上で入力してください") }
            return
        }
        mutableState.update { it.copy(isSubmitting = true, error = null) }
        viewModelScope.launch {
            runCatching {
                val token = ApiClient.authenticate(current.email.trim(), current.password, current.signUp)
                withContext(Dispatchers.IO) { SecureTokenStore.set(token) }
                ApiClient.currentUser().also(SecureTokenStore::setAccount)
            }.onSuccess { user ->
                mutableState.update { it.copy(isSubmitting = false, signedIn = true, user = user, password = "") }
            }.onFailure { error ->
                withContext(Dispatchers.IO) { SecureTokenStore.clear() }
                SecureTokenStore.clearAccountId()
                mutableState.update { it.copy(isSubmitting = false, error = authErrorMessage(error, current.signUp)) }
            }
        }
    }

    /** Returns an error message, or null once the account has been deleted and signed out. */
    suspend fun deleteAccount(password: String): String? {
        val result = runCatching { ApiClient.deleteAccount(password) }
        result.exceptionOrNull()?.let { error ->
            return (error as? ApiException)?.message ?: "アカウントを削除できませんでした。通信環境を確認してください"
        }
        BackupCoordinator.forgetAccount(RemoApplication.context)
        withContext(Dispatchers.IO) { SecureTokenStore.clear() }
        SecureTokenStore.clearAccountId()
        mutableState.value = AuthUiState(initialized = true)
        return null
    }

    fun signOut() {
        viewModelScope.launch {
            ApiClient.signOut()
            withContext(Dispatchers.IO) { SecureTokenStore.clear() }
            SecureTokenStore.clearAccountId()
            BackupCoordinator.resetSession()
            mutableState.value = AuthUiState(initialized = true)
        }
    }
}

/** True when the API answered that the session token is not valid (as opposed to being unreachable). */
internal fun isSessionRejected(error: Throwable): Boolean = (error as? ApiException)?.statusCode == 401

/** Maps API and network failures to messages a person can act on. */
internal fun authErrorMessage(error: Throwable, signUp: Boolean): String {
    val api = error as? ApiException
    val code = api?.code?.uppercase()
    return when {
        api == null && error is java.io.IOException -> "サーバーに接続できません。通信環境を確認してください"
        // The server may require a confirmed address before the first sign-in.
        code == "MISSING_AUTH_TOKEN" && signUp -> "確認メールを送信しました。メール内のリンクを開いてからログインしてください"
        code == "EMAIL_NOT_VERIFIED" -> "メールアドレスの確認が必要です。届いた確認メールのリンクを開いてから、もう一度ログインしてください"
        code == "USER_ALREADY_EXISTS" || (signUp && api?.statusCode in setOf(409, 422)) -> "このメールアドレスはすでに登録されています"
        code == "INVALID_EMAIL" -> "メールアドレスの形式を確認してください"
        code == "PASSWORD_TOO_SHORT" -> "パスワードは8文字以上で入力してください"
        code == "INVALID_EMAIL_OR_PASSWORD" || (!signUp && api?.statusCode in setOf(400, 401, 403)) -> "メールアドレスまたはパスワードが正しくありません"
        api?.statusCode == 429 -> "試行回数が多すぎます。しばらくしてから再度お試しください"
        api != null && api.statusCode >= 500 -> "サーバーで問題が発生しました。時間をおいて再度お試しください"
        api != null && api.statusCode == 404 -> "サーバーに接続できませんでした（接続先を確認してください）"
        api != null -> "${if (signUp) "登録" else "ログイン"}できませんでした（エラー ${api.statusCode}）"
        else -> "${if (signUp) "登録" else "ログイン"}できませんでした。時間をおいて再度お試しください"
    }
}
