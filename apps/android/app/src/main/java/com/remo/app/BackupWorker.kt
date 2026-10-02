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

/** The stored session is no longer accepted: the user has to sign in again. */
class SessionExpiredException : Exception("セッションの有効期限が切れました")

/** A single gate shared by foreground refreshes and durable background backup. */
object BackupCoordinator {
    const val STATUS_LOCAL = "端末に保存済み"
    const val STATUS_WAITING = "バックアップ待ち"
    const val STATUS_DONE = "バックアップ済み"
    const val STATUS_PHOTOS_WAITING = "写真バックアップ待ち"
    const val STATUS_OTHER_ACCOUNT = "別のアカウントの記録があります"

    private val mutex = Mutex()
    private var lastAttemptAt: Long? = null
    private var lastSuccessAt: Long? = null
    private var lastPullAt: Long? = null
    private var syncedRevision = -1L
    private var accountToken: String? = null
    private var status = STATUS_WAITING

    private const val PULL_INTERVAL_MS = 2 * 60_000L

    private fun preferences(context: Context) = context.getSharedPreferences("rem_sync", Context.MODE_PRIVATE)

    fun lastSuccessAt(context: Context, token: String? = SecureTokenStore.get()): Long? {
        val accountToken = token ?: return null
        val stableKey = "sync_last_success_${accountKey(accountToken)}"
        val legacyKey = "sync_last_success_${accountToken.hashCode()}"
        return preferences(context).getLong(stableKey, preferences(context).getLong(legacyKey, -1L))
            .takeIf { it > 0L }
    }

    fun resetSession() {
        accountToken = null
        lastAttemptAt = null
        lastSuccessAt = null
        lastPullAt = null
        syncedRevision = -1L
        status = STATUS_LOCAL
    }

    /**
     * Forgets the sync state of the signed-in account after that account has been deleted:
     * its download position and last backup time. The records stay and count as not backed
     * up, so a later account receives all of them.
     */
    suspend fun forgetAccount(context: Context) {
        val token = SecureTokenStore.get() ?: return
        preferences(context).edit {
            remove(cursorKey(token))
            remove(legacyCursorKey(token))
            remove(fullPageKey(token))
            remove("sync_last_success_${accountKey(token)}")
            remove("sync_last_success_${token.hashCode()}")
        }
        SecureTokenStore.accountId()?.let { LogStore.get(context).releaseOwner(it) }
        resetSession()
    }

    private fun accountKey(token: String): String = SecureTokenStore.accountId()?.let { "account_$it" } ?: "token_${token.hashCode()}"

    private fun legacyCursorKey(token: String): String = "sync_cursor_${token.hashCode()}"
    private fun cursorKey(token: String): String = "sync_cursor_${accountKey(token)}"
    /** Where an interrupted full download continues. */
    private fun fullPageKey(token: String): String = "sync_full_page_${accountKey(token)}"

    private fun loadCursor(context: Context, token: String): SyncCursor? {
        val preferences = preferences(context)
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

    /** True when the records on this device are backed up to another account than the signed-in one. */
    suspend fun belongsToOtherAccount(context: Context): Boolean {
        val account = SecureTokenStore.accountId() ?: return false
        val store = LogStore.get(context)
        val owner = store.owner() ?: return false
        return owner != account && store.count() > 0
    }

    /** The user decided to back this device's records up to the signed-in account as well. */
    suspend fun adoptRecords(context: Context) {
        val account = SecureTokenStore.accountId() ?: return
        LogStore.get(context).claim(account)
        resetSession()
    }

    /** The user decided to remove the other account's records from this device. */
    suspend fun replaceRecords(context: Context) = mutex.withLock {
        val account = SecureTokenStore.accountId() ?: return@withLock
        clearDevice(context)
        LogStore.get(context).claim(account)
        SecureTokenStore.get()?.let { token -> preferences(context).edit { remove(cursorKey(token)); remove(fullPageKey(token)) } }
        resetSession()
    }

    /**
     * Backs this device's changes up and, when due, brings in what other devices changed.
     * Only records that are not in the backup yet are uploaded: a record another device
     * deleted from the backup is not sent back by a device that still has its own copy.
     */
    suspend fun synchronize(context: Context, force: Boolean = false): String = withContext(Dispatchers.IO) { mutex.withLock {
        val token = SecureTokenStore.get() ?: return@withLock STATUS_LOCAL
        val account = SecureTokenStore.accountId() ?: return@withLock STATUS_LOCAL
        val store = LogStore.get(context)
        store.reload()
        val owner = store.owner()
        // The records belong to another account until the user decides otherwise.
        if (owner != null && owner != account && store.count() > 0) return@withLock STATUS_OTHER_ACCOUNT
        if (owner != account) store.claim(account)
        if (accountToken != account) {
            accountToken = account
            lastAttemptAt = null
            lastSuccessAt = null
            lastPullAt = null
            syncedRevision = -1L
        }
        val now = SystemClock.elapsedRealtime()
        if (!force && lastAttemptAt?.let { now - it < 60_000L } == true) {
            return@withLock if (store.revision != syncedRevision || store.hasPendingChanges) STATUS_WAITING else status
        }
        if (!force && store.revision == syncedRevision && !store.hasPendingChanges
            && lastSuccessAt?.let { now - it < 15 * 60_000L } == true) return@withLock status
        lastAttemptAt = now
        status = STATUS_WAITING
        try {
            while (true) {
                val deletions = store.pendingDeletions(ApiClient.BATCH_SIZE)
                if (deletions.isEmpty()) break
                ApiClient.pushDeletions(deletions, token)
                store.markDeletionsSynced(deletions)
            }
            // Each batch is marked as it is acknowledged, so an interrupted
            // first backup continues instead of starting over.
            while (true) {
                val batch = store.dirtyEntries(ApiClient.BATCH_SIZE)
                if (batch.isEmpty()) break
                ApiClient.pushEvents(batch, token)
                store.markSynced(batch)
            }
            val revisionAfterPush = store.revision
            val pullDue = force || (lastPullAt?.let { now - it >= PULL_INTERVAL_MS } ?: true)
            if (pullDue) {
                pull(context, store, token)
                syncPlaces(store, token)
                // Never keep an old account's response after sign-out/account change.
                if (SecureTokenStore.get() != token) return@withLock STATUS_WAITING
                lastPullAt = SystemClock.elapsedRealtime()
            }
            val photosPending = try {
                PhotoBackup.uploadPending(context, token)
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (isSessionRejected(error)) throw error
                true
            }
            // Records the download wrote do not need another backup round.
            syncedRevision = if (store.hasPendingChanges) revisionAfterPush else store.revision
            lastSuccessAt = SystemClock.elapsedRealtime()
            preferences(context).edit { putLong("sync_last_success_${accountKey(token)}", System.currentTimeMillis()) }
            status = if (photosPending) STATUS_PHOTOS_WAITING else STATUS_DONE
            status
        } catch (error: ApiException) {
            if (isSessionRejected(error)) throw SessionExpiredException()
            throw error
        }
    } }

    /** Downloads page by page and applies each page, so a restore is never held in memory. */
    private suspend fun pull(context: Context, store: LogStore, token: String) {
        val preferences = preferences(context)
        val stored = loadCursor(context, token)
        if (stored != null) {
            val head = ApiClient.fetchEventHead(token)
            if (head == null || ApiClient.compareCursors(head, stored) <= 0) return
        }
        var page: String? = if (stored == null) preferences.getString(fullPageKey(token), null) else null
        var cursor = stored
        var reached: SyncCursor? = null
        while (true) {
            val result = ApiClient.fetchEventPage(token, cursor, page)
            if (SecureTokenStore.get() != token) return
            store.applyRemote(result.events, result.deletions)
            reached = result.cursor ?: reached
            if (result.nextPage != null) {
                page = result.nextPage
                preferences.edit { putString(fullPageKey(token), page) }
            } else if (result.nextCursorToken != null && SyncCursor.parse(result.nextCursorToken) != null) {
                page = null
                cursor = SyncCursor.parse(result.nextCursorToken)
            } else {
                break
            }
        }
        // Only a cursor returned by a read is safe to keep: a write response says
        // nothing about what other devices committed in between.
        preferences.edit {
            reached?.takeIf { it.updatedAt >= 0L }?.let { putString(cursorKey(token), it.token()) }
            remove(fullPageKey(token))
        }
    }

    private suspend fun syncPlaces(store: LogStore, token: String) {
        store.dirtyPlaces().chunked(200).forEach { batch ->
            ApiClient.pushPlaces(batch, token)
            store.markPlacesSynced(batch)
        }
        store.applyRemotePlaces(ApiClient.fetchPlaces(token))
    }

    private suspend fun clearDevice(context: Context) {
        LogStore.get(context).clearAll()
        StayIndexStorage.delete(context)
        PhotoLibrary.clearCache(context)
    }

    suspend fun deleteAll(context: Context) = mutex.withLock {
        // Without an account there is no cloud backup: only this device is cleared.
        val token = SecureTokenStore.get()
        if (token != null && !belongsToOtherAccount(context)) {
            ApiClient.deleteAllData()
            preferences(context).edit { remove(cursorKey(token)); remove(fullPageKey(token)) }
        }
        AutomaticCaptureService.setEnabled(context, false)
        clearDevice(context)
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
    } catch (_: SessionExpiredException) {
        // Retrying cannot help; the app asks to sign in again when it is opened.
        Result.success()
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
