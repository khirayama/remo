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
            val user = runCatching {
                if (SecureTokenStore.get() == null) null else ApiClient.currentUser()
            }.getOrNull()
            if (user == null) {
                SecureTokenStore.clear()
                SecureTokenStore.clearAccountId()
            } else {
                SecureTokenStore.setAccountId(user.id)
            }
            mutableState.update { it.copy(initialized = true, signedIn = user != null, user = user) }
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
                ApiClient.currentUser().also { SecureTokenStore.setAccountId(it.id) }
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
        withContext(Dispatchers.IO) {
            BackupCoordinator.forgetAccount(RemoApplication.context)
            SecureTokenStore.clear()
        }
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

/** Maps API and network failures to messages a person can act on. */
internal fun authErrorMessage(error: Throwable, signUp: Boolean): String {
    val api = error as? ApiException
    val code = api?.code?.uppercase()
    return when {
        api == null && error is java.io.IOException -> "サーバーに接続できません。通信環境を確認してください"
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
