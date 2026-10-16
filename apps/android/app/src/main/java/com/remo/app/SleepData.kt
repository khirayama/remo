package com.remo.app

import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import kotlinx.coroutines.CancellationException

data class SleepSession(val startedAt: Long, val endedAt: Long) {
    val durationMs: Long get() = endedAt - startedAt
}

/** A night's sleep starts on the previous day, so sessions are read from this far before the day. */
private const val SLEEP_LOOKBACK_MS = 24 * 60 * 60 * 1000L

/**
 * Sleep that ended within [day] (one day or a range of days), oldest first: a night counts for the day it ends on.
 * Several apps can write the same night to Health Connect, so overlapping sessions become one.
 */
fun sleepSessionsEndingIn(sessions: List<SleepSession>, day: LongRange): List<SleepSession> {
    val merged = mutableListOf<SleepSession>()
    for (session in sessions.filter { it.endedAt > it.startedAt }.sortedBy(SleepSession::startedAt)) {
        val previous = merged.lastOrNull()
        if (previous != null && session.startedAt <= previous.endedAt) {
            merged[merged.lastIndex] = previous.copy(endedAt = maxOf(previous.endedAt, session.endedAt))
        } else {
            merged += session
        }
    }
    return merged.filter { it.endedAt in day }
}

/**
 * Sleep is read from Health Connect whenever a day is shown or exported.
 * It is never stored or backed up: Health Connect stays the only copy on the device.
 */
object SleepData {
    val permission: String = HealthPermission.getReadPermission(SleepSessionRecord::class)

    fun isAvailable(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE

    suspend fun hasAccess(context: Context): Boolean = isAvailable(context) && attempt(false) {
        permission in HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
    }

    suspend fun sessionsEndingIn(context: Context, day: LongRange): List<SleepSession> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P || !isAvailable(context)) return emptyList()
        return attempt(emptyList()) { sleepSessionsEndingIn(read(context, day.first - SLEEP_LOOKBACK_MS, day.last + 1), day) }
    }

    @RequiresApi(Build.VERSION_CODES.P)
    private suspend fun read(context: Context, from: Long, until: Long): List<SleepSession> {
        val client = HealthConnectClient.getOrCreate(context)
        val range = TimeRangeFilter.between(Instant.ofEpochMilli(from), Instant.ofEpochMilli(until))
        val sessions = mutableListOf<SleepSession>()
        var pageToken: String? = null
        do {
            val response = client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, range, pageToken = pageToken))
            response.records.mapTo(sessions) { SleepSession(it.startTime.toEpochMilli(), it.endTime.toEpochMilli()) }
            pageToken = response.pageToken
        } while (pageToken != null)
        return sessions
    }

    // Health Connect can be updating, disabled or have the permission revoked at any time; the timeline then shows no sleep.
    private inline fun <T> attempt(fallback: T, block: () -> T): T = try {
        block()
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        fallback
    }
}
