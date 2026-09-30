package com.remo.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDefaults
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Circular tinted badge used for timeline kinds, settings and empty states. */
@Composable
internal fun IconBadge(icon: ImageVector, tint: Color, container: Color, modifier: Modifier = Modifier, size: Dp = 32.dp, iconSize: Dp = 18.dp) {
    Box(modifier.size(size).background(container, CircleShape), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(iconSize))
    }
}

/** 48dp floating control drawn on top of the map. */
@Composable
internal fun MapControlButton(icon: ImageVector, description: String, enabled: Boolean = true, onClick: () -> Unit) {
    Surface(Modifier.size(48.dp).alpha(if (enabled) 1f else 0.6f), shape = CircleShape, color = AppColors.surface, shadowElevation = 3.dp) {
        IconButton(onClick = onClick, enabled = enabled) {
            Icon(icon, description, tint = AppColors.ink, modifier = Modifier.size(24.dp))
        }
    }
}

/** 36×4 grab bar with 10/6dp breathing room (Material's default adds 22dp above and below). */
@Composable
internal fun SheetHandle() {
    Box(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 6.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(width = 36.dp, height = 4.dp).background(AppColors.outlineStrong, CircleShape))
    }
}

@Composable
internal fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = AppColors.inkSecondary, modifier = modifier)
}

/** Material 3 date picker bound to the app's `yyyy-MM-dd` day keys. Future days cannot be chosen. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RemoDatePickerDialog(value: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    val todayUtc = remember { utcMillis(dayKey(System.currentTimeMillis())) }
    val state = rememberDatePickerState(
        initialSelectedDateMillis = utcMillis(value),
        yearRange = 2020..Calendar.getInstance().get(Calendar.YEAR),
        selectableDates = object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long) = utcTimeMillis <= todayUtc
        },
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(enabled = state.selectedDateMillis != null, onClick = { state.selectedDateMillis?.let { onConfirm(utcDayKey(it)) } }) { Text("決定") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
        colors = DatePickerDefaults.colors(containerColor = AppColors.surface),
    ) {
        DatePicker(
            state = state,
            showModeToggle = false,
            title = { Text("日付を選択", style = MaterialTheme.typography.labelLarge, color = AppColors.inkSecondary, modifier = Modifier.padding(start = 24.dp, top = 16.dp)) },
            colors = DatePickerDefaults.colors(containerColor = AppColors.surface),
        )
    }
}

// ---- Formatting -----------------------------------------------------------

internal fun dayKey(value: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(value))

internal fun parseDate(value: String): Calendar = Calendar.getInstance().apply {
    time = SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(value) ?: Date()
}

internal fun shiftDay(value: String, days: Int): String = dayKey(parseDate(value).apply { add(Calendar.DAY_OF_YEAR, days) }.timeInMillis)

private fun utcMillis(value: String): Long = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(value)?.time ?: 0L

private fun utcDayKey(value: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(value))

/** "9月1日（火）" */
internal fun formatDayTitle(value: String): String = SimpleDateFormat("M月d日（E）", Locale.JAPAN).format(parseDate(value).time)

/** "2026年9月1日（火）" */
internal fun formatDate(value: String): String = SimpleDateFormat("yyyy年M月d日（E）", Locale.JAPAN).format(parseDate(value).time)

/** "2026年 · 今日" — the year plus a relative hint for recent days. */
internal fun formatDaySubtitle(value: String): String {
    val today = dayKey(System.currentTimeMillis())
    val relative = when (value) {
        today -> "今日"
        shiftDay(today, -1) -> "昨日"
        else -> null
    }
    return listOfNotNull("${parseDate(value).get(Calendar.YEAR)}年", relative).joinToString(" · ")
}

internal fun formatTime(value: Long): String = SimpleDateFormat("HH:mm", Locale.JAPAN).format(Date(value))
internal fun formatDateTime(value: Long): String = SimpleDateFormat("yyyy年M月d日 HH:mm", Locale.JAPAN).format(Date(value))
internal fun formatDayTime(value: Long): String = SimpleDateFormat("M月d日（E） HH:mm", Locale.JAPAN).format(Date(value))
internal fun formatBackupTime(timestamp: Long): String = SimpleDateFormat("M月d日 HH:mm", Locale.JAPAN).format(Date(timestamp))

internal fun elapsedStayLabel(durationMs: Long): String {
    val minutes = maxOf(1L, (durationMs + 30_000L) / 60_000L)
    val hours = minutes / 60
    val remainder = minutes % 60
    return if (hours > 0) "${hours}時間${if (remainder > 0) "${remainder}分" else ""}" else "${minutes}分"
}

internal fun activityDurationLabel(durationMs: Long): String {
    if (durationMs < 60_000L) return "1分未満"
    val minutes = durationMs / 60_000L
    val hours = minutes / 60
    val remainder = minutes % 60
    return if (hours > 0) "${hours}時間${if (remainder > 0) "${remainder}分" else ""}" else "${minutes}分"
}

internal fun formatDistance(distanceMeters: Double?): String = when {
    distanceMeters == null || !distanceMeters.isFinite() -> "距離不明"
    distanceMeters < 1_000 -> "${distanceMeters.toInt()} m"
    else -> "${"%.1f".format(Locale.US, distanceMeters / 1_000)} km"
}

internal fun mediaCountLabel(entry: LogEntry): String = if (entry.mediaType == MediaType.VIDEO) "動画 ${entry.photoCount}本" else "写真 ${entry.photoCount}枚"

internal fun mediaSummary(photoCount: Int, videoCount: Int): String = listOfNotNull(
    photoCount.takeIf { it > 0 }?.let { "写真 ${it}枚" },
    videoCount.takeIf { it > 0 }?.let { "動画 ${it}本" },
).joinToString(" · ").ifEmpty { "メディアなし" }

internal fun mediaSummary(entries: List<LogEntry>): String = mediaSummary(
    entries.filter { it.mediaType != MediaType.VIDEO }.sumOf { it.photoCount },
    entries.filter { it.mediaType == MediaType.VIDEO }.sumOf { it.photoCount },
)

internal fun formatCoordinates(entry: LogEntry): String = formatCoordinates(entry.latitude, entry.longitude)
internal fun formatCoordinates(latitude: Double?, longitude: Double?): String =
    if (hasUsableCoordinates(latitude, longitude)) "%.5f, %.5f".format(Locale.US, latitude, longitude) else "位置情報なし"

internal fun nearestLibraryPhoto(entry: LogEntry, photos: List<LibraryPhoto>): LibraryPhoto? = LibraryPhotoLookup.forPhotos(photos).nearest(entry)
