package com.remo.app

import android.content.Context
import android.os.SystemClock
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.core.content.edit
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/** A single gate shared by foreground refreshes and durable background backup. */
object BackupCoordinator {
    private val mutex = Mutex()
    private var lastAttemptAt: Long? = null
    private var lastSuccessAt: Long? = null
    private var lastPullAt: Long? = null
    private var syncedRevision = -1L
    private var accountToken: String? = null
    private var status = "バックアップ待ち"

    private const val PULL_INTERVAL_MS = 2 * 60_000L

    fun lastSuccessAt(context: Context, token: String? = SecureTokenStore.get()): Long? {
        val accountToken = token ?: return null
        val preferences = context.getSharedPreferences("rem_sync", Context.MODE_PRIVATE)
        val stableKey = "sync_last_success_${accountKey(accountToken)}"
        val legacyKey = "sync_last_success_${accountToken.hashCode()}"
        return preferences.getLong(stableKey, preferences.getLong(legacyKey, -1L))
            .takeIf { it > 0L }
    }

    fun resetSession() {
        accountToken = null
        lastAttemptAt = null
        lastSuccessAt = null
        lastPullAt = null
        syncedRevision = -1L
        status = "端末に保存済み"
    }

    /**
     * Forgets the sync state of the signed-in account after that account has been deleted:
     * its download cursor, last backup time and any partial full sync. Local records stay.
     */
    fun forgetAccount(context: Context) {
        val token = SecureTokenStore.get() ?: return
        context.getSharedPreferences("rem_sync", Context.MODE_PRIVATE).edit {
            remove(cursorKey(token))
            remove(legacyCursorKey(token))
            remove("sync_last_success_${accountKey(token)}")
            remove("sync_last_success_${token.hashCode()}")
        }
        SecureTokenStore.accountId()?.let(ApiClient::discardFullSyncStaging)
        resetSession()
    }

    private fun accountKey(token: String): String = SecureTokenStore.accountId()?.let { "account_$it" } ?: "token_${token.hashCode()}"

    private fun legacyCursorKey(token: String): String = "sync_cursor_${token.hashCode()}"
    private fun cursorKey(token: String): String = "sync_cursor_${accountKey(token)}"

    private fun loadCursor(context: Context, token: String): SyncCursor? {
        val preferences = context.getSharedPreferences("rem_sync", Context.MODE_PRIVATE)
        val key = cursorKey(token)
        val stored = runCatching {
            preferences.getString(key, null) ?: preferences.getString(legacyCursorKey(token), null)?.also {
                preferences.edit { putString(key, it); remove(legacyCursorKey(token)) }
            }
        }.getOrNull()
        SyncCursor.parse(stored)?.let { return it }
        if (preferences.contains(key)) preferences.edit { remove(key) }
        return null
    }

    private fun saveCursor(context: Context, token: String, cursor: SyncCursor?) {
        cursor?.takeIf { it.updatedAt >= 0L }?.let { validCursor ->
            context.getSharedPreferences("rem_sync", Context.MODE_PRIVATE)
                .edit { putString(cursorKey(token), validCursor.token()) }
        }
    }

    suspend fun synchronize(context: Context, force: Boolean = false): String = withContext(Dispatchers.IO) { mutex.withLock {
        val token = SecureTokenStore.get() ?: return@withLock "端末に保存済み"
        val store = LogStore.get(context)
        store.reload()
        val sessionKey = SecureTokenStore.accountId() ?: token
        if (accountToken != sessionKey) {
            accountToken = sessionKey
            lastAttemptAt = null
            lastSuccessAt = null
            lastPullAt = null
            syncedRevision = -1L
        }
        val now = SystemClock.elapsedRealtime()
        if (!force && lastAttemptAt?.let { now - it < 60_000L } == true) {
            return@withLock if (store.revision != syncedRevision || store.pendingDeleteIds.isNotEmpty() || store.pendingUpsertIds.isNotEmpty()) "バックアップ待ち" else status
        }
        if (!force && store.revision == syncedRevision && store.pendingDeleteIds.isEmpty() && store.pendingUpsertIds.isEmpty()
            && lastSuccessAt?.let { now - it < 15 * 60_000L } == true) return@withLock status
        lastAttemptAt = now
        status = "バックアップ待ち"
        val pendingDeletes = store.pendingDeleteIds.toList()
        ApiClient.deleteEvents(pendingDeletes, token)
        pendingDeletes.forEach { store.markDeleteSynced(it) }
        val revisionAtStart = store.revision
        val localAtStart = store.logs
        val pendingUpsertsAtStart = store.pendingUpsertEntries
        val pullDue = force || (lastPullAt?.let { now - it >= PULL_INTERVAL_MS } ?: true)
        val snapshot = ApiClient.synchronizeEvents(
            local = localAtStart,
            pendingUpserts = pendingUpsertsAtStart,
            token = token,
            checkpoint = loadCursor(context, token),
            pull = pullDue,
        )
        // Never import an old account's response after sign-out/account change.
        if (SecureTokenStore.get() != token) return@withLock "バックアップ待ち"
        store.mergeSynced(snapshot, localAtStart)
        store.markUpsertsSynced(snapshot.uploaded)
        val photosPending = try {
            PhotoBackup.uploadPending(context, store.logs, token)
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            true
        }
        saveCursor(context, token, snapshot.nextCursor)
        if (pullDue) lastPullAt = SystemClock.elapsedRealtime()
        syncedRevision = revisionAtStart
        lastSuccessAt = SystemClock.elapsedRealtime()
        context.getSharedPreferences("rem_sync", Context.MODE_PRIVATE)
            .edit { putLong("sync_last_success_${accountKey(token)}", System.currentTimeMillis()) }
        status = if (photosPending) "写真バックアップ待ち" else "バックアップ済み"
        status
    } }

    suspend fun deleteAll(context: Context) = mutex.withLock {
        ApiClient.deleteAllData()
        AutomaticCaptureService.setEnabled(context, false)
        LogStore.get(context).clearAll()
        StayIndexStorage.delete(context)
        PhotoLibrary.clearCache(context)
        syncedRevision = -1L
        lastAttemptAt = null
        lastSuccessAt = null
        lastPullAt = null
    }
}

class BackupWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result = try {
        BackupCoordinator.synchronize(applicationContext)
        Result.success()
    } catch (cancelled: kotlinx.coroutines.CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        Result.retry()
    }

    companion object {
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<BackupWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("remo-backup", ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
