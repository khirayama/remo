package com.remo.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import android.security.keystore.KeyPermanentlyInvalidatedException
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Outcome of reading the stored session token. */
sealed interface TokenResult {
    data class Available(val token: String) : TokenResult
    /** No token is stored (never signed in, or permanently unreadable data was cleared). */
    data object Missing : TokenResult
    /** The token exists but cannot be read right now (transient Keystore/crypto failure); it is kept. */
    data object Unavailable : TokenResult
}

object SecureTokenStore {
    private const val preferences = "rem_auth"
    private const val tokenKey = "better_auth_token"
    private const val accountIdKey = "account_id"
    private const val accountEmailKey = "account_email"
    private const val accountNameKey = "account_name"
    private const val keyAlias = "rem_better_auth_token"

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(
                    keyAlias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
        }.generateKey()
    }

    /**
     * Reads the token. Only permanent damage (undecodable/truncated data, an
     * authentication-tag mismatch, or a permanently invalidated/missing key)
     * clears the stored token; any other failure is reported as [TokenResult.Unavailable]
     * and leaves the token in place.
     */
    fun read(): TokenResult {
        val encoded = RemoApplication.context.getSharedPreferences(preferences, 0).getString(tokenKey, null)
            ?: return TokenResult.Missing
        return try {
            val bytes = Base64.decode(encoded, Base64.NO_WRAP)
            if (bytes.size <= 12) throw PermanentTokenFailure()
            val key = existingKey() ?: throw PermanentTokenFailure()
            TokenResult.Available(
                Cipher.getInstance("AES/GCM/NoPadding").run {
                    init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                    String(doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
                },
            )
        } catch (error: Exception) {
            if (isPermanent(error)) {
                clear()
                TokenResult.Missing
            } else {
                TokenResult.Unavailable
            }
        }
    }

    /** The token, or null when absent or temporarily unreadable (see [read]). */
    fun get(): String? = (read() as? TokenResult.Available)?.token

    private class PermanentTokenFailure : Exception()

    private fun existingKey(): SecretKey? {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return keyStore.getKey(keyAlias, null) as? SecretKey
    }

    private fun isPermanent(error: Throwable): Boolean = generateSequence(error) { it.cause }.any {
        it is PermanentTokenFailure ||
            it is IllegalArgumentException || // malformed Base64 or invalid cipher parameters
            it is IndexOutOfBoundsException ||
            it is AEADBadTagException ||
            it is KeyPermanentlyInvalidatedException ||
            it is UnrecoverableKeyException
    }

    fun set(value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, secretKey()) }
        val encrypted = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        RemoApplication.context.getSharedPreferences(preferences, 0).edit {
            putString(tokenKey, Base64.encodeToString(encrypted, Base64.NO_WRAP))
        }
    }

    fun accountId(): String? = RemoApplication.context.getSharedPreferences(preferences, 0)
        .getString(accountIdKey, null)
        ?.takeIf(String::isNotBlank)

    fun setAccountId(value: String) {
        RemoApplication.context.getSharedPreferences(preferences, 0).edit { putString(accountIdKey, value) }
    }

    /** Remembers who is signed in, so the app can start without reaching the API. */
    fun setAccount(user: RemoUser) {
        RemoApplication.context.getSharedPreferences(preferences, 0).edit {
            putString(accountIdKey, user.id)
            putString(accountEmailKey, user.email)
            putString(accountNameKey, user.name)
        }
    }

    /** The signed-in user as last confirmed by the API, or null when unknown. */
    fun cachedAccount(): RemoUser? {
        val stored = RemoApplication.context.getSharedPreferences(preferences, 0)
        val id = stored.getString(accountIdKey, null)?.takeIf(String::isNotBlank) ?: return null
        return RemoUser(id, stored.getString(accountEmailKey, null).orEmpty(), stored.getString(accountNameKey, null).orEmpty())
    }

    fun clearAccountId() {
        RemoApplication.context.getSharedPreferences(preferences, 0).edit {
            remove(accountIdKey)
            remove(accountEmailKey)
            remove(accountNameKey)
        }
    }

    fun clear() {
        RemoApplication.context.getSharedPreferences(preferences, 0).edit { remove(tokenKey) }
    }
}
