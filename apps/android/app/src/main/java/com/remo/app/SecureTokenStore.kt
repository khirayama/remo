package com.remo.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object SecureTokenStore {
    private const val preferences = "rem_auth"
    private const val tokenKey = "better_auth_token"
    private const val accountIdKey = "account_id"
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

    fun get(): String? {
        val encoded = RemoApplication.context.getSharedPreferences(preferences, 0).getString(tokenKey, null) ?: return null
        return try {
            val bytes = Base64.decode(encoded, Base64.NO_WRAP)
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                String(doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
            }
        } catch (_: Exception) {
            clear()
            null
        }
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

    fun clearAccountId() {
        RemoApplication.context.getSharedPreferences(preferences, 0).edit { remove(accountIdKey) }
    }

    fun clear() {
        RemoApplication.context.getSharedPreferences(preferences, 0).edit { remove(tokenKey) }
    }
}
