package com.remo.app

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.ChevronLeft
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.EventBusy
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.Route
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.google.android.gms.maps.model.LatLng
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Collapsed sheet: handle + day header + summary chips. */
internal val SheetPeekContentHeight = 124.dp

/** Unassigned photos taken within this gap of each other share one timeline row. */
private const val PHOTO_GROUP_GAP_MS = 30 * 60 * 1000L

private sealed interface SheetItem {
    val id: String
    val startedAt: Long

    data class Activity(val activity: TimelineActivity) : SheetItem {
        override val id get() = activity.id
        override val startedAt get() = activity.startedAt
    }

    data class Photos(val entries: List<LogEntry>) : SheetItem {
        override val id get() = "photos:${entries.first().id}"
        override val startedAt get() = entries.first().startedAt
    }
}

private fun buildSheetItems(timeline: TimelineRenderSnapshot): List<SheetItem> {
    val assignedPhotoIds = timeline.activities.flatMap { it.photos }.map { it.id }.toSet()
    val loosePhotos = timeline.displayLogs.filter { it.source == EventSource.PHOTO && it.id !in assignedPhotoIds }
    val ordered = (timeline.activities.map { SheetItem.Activity(it) } + loosePhotos.map { SheetItem.Photos(listOf(it)) })
        .sortedWith(compareBy<SheetItem> { it.startedAt }.thenBy { if (it is SheetItem.Activity) 0 else 1 })
    val result = mutableListOf<SheetItem>()
    for (item in ordered) {
        val previous = result.lastOrNull()
        if (item is SheetItem.Photos && previous is SheetItem.Photos && item.startedAt - previous.entries.last().startedAt <= PHOTO_GROUP_GAP_MS) {
            result[result.lastIndex] = SheetItem.Photos(previous.entries + item.entries)
        } else {
            result += item
        }
    }
    return result
}

private data class DaySummary(val distanceMeters: Double, val stayCount: Int, val photoCount: Int, val videoCount: Int) {
    val isEmpty: Boolean get() = distanceMeters <= 0.0 && stayCount == 0 && photoCount == 0 && videoCount == 0
}

private fun daySummary(timeline: TimelineRenderSnapshot): DaySummary {
    val media = timeline.displayLogs.filter { it.source == EventSource.PHOTO }
    return DaySummary(
        distanceMeters = timeline.activities.filter { it.kind == TimelineActivityKind.MOVEMENT }.sumOf { it.distanceMeters?.takeIf(Double::isFinite) ?: 0.0 },
        stayCount = timeline.activities.count { it.kind == TimelineActivityKind.STAY },
        photoCount = media.filter { it.mediaType != MediaType.VIDEO }.sumOf { it.photoCount },
        videoCount = media.filter { it.mediaType == MediaType.VIDEO }.sumOf { it.photoCount },
    )
}

@Composable
internal fun TimelineSheetContent(
    selectedDate: String,
    timeline: TimelineRenderSnapshot,
    loaded: Boolean,
    photos: List<LibraryPhoto>,
    autoCapture: Boolean,
    selectedActivityId: String?,
    listState: LazyListState,
    bottomPadding: Dp,
    modifier: Modifier = Modifier,
    onDateChange: (String) -> Unit,
    onFocus: (TimelineActivity) -> Unit,
    onSelectPhotos: (List<LogEntry>) -> Unit,
    onOpenHistory: (PlaceHistoryTarget) -> Unit,
) {
    val context = LocalContext.current
    var showPicker by remember { mutableStateOf(false) }
    var placeLabels by remember(selectedDate) { mutableStateOf<Map<String, StayPlaceLabel>>(emptyMap()) }
    var placesExpanded by rememberSaveable { mutableStateOf(false) }
    val items = remember(timeline) { buildSheetItems(timeline) }
    val summary = remember(timeline) { daySummary(timeline) }
    fun onLabel(id: String, label: StayPlaceLabel) { placeLabels = placeLabels + (id to label) }

    LazyColumn(modifier.fillMaxWidth(), state = listState, contentPadding = PaddingValues(bottom = bottomPadding)) {
        item(key = "header") {
            DayHeader(selectedDate, onDateChange) { showPicker = true }
        }
        item(key = "summary") {
            DaySummaryRow(summary, loaded)
        }
        when {
            !loaded -> item(key = "loading") {
                Box(Modifier.fillMaxWidth().padding(vertical = 32.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(24.dp), color = AppColors.green, strokeWidth = 2.dp)
                }
            }
            items.isEmpty() -> item(key = "empty") { EmptyTimeline(autoCapture) }
            else -> {
                item(key = "timeline-label") {
                    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        SectionLabel("タイムライン")
                        Spacer(Modifier.weight(1f))
                        Text("${items.size}件", style = MaterialTheme.typography.labelMedium, color = AppColors.inkTertiary)
                    }
                }
                itemsIndexed(items, key = { _, item -> item.id }) { index, item ->
                    when (item) {
                        is SheetItem.Activity -> ActivityRow(
                            activity = item.activity,
                            label = placeLabels[item.id],
                            isFirst = index == 0,
                            isLast = index == items.lastIndex,
                            selected = selectedActivityId == item.id,
                            photos = photos,
                            onLabel = { onLabel(item.id, it) },
                            onClick = { onFocus(item.activity) },
                            onSelectPhotos = onSelectPhotos,
                            onOpenHistory = { item.activity.coordinate?.let { onOpenHistory(PlaceHistoryTarget(it, placeLabels[item.id])) } },
                        )
                        is SheetItem.Photos -> PhotoGroupRow(item.entries, index == 0, index == items.lastIndex, photos) { onSelectPhotos(item.entries) }
                    }
                }
            }
        }
        if (loaded && timeline.stayPlaces.isNotEmpty()) {
            stayPlacesSection(timeline.stayPlaces, placeLabels, placesExpanded, { placesExpanded = !placesExpanded }, ::onLabel, onOpenHistory)
        }
    }
    if (showPicker) {
        RemoDatePickerDialog(selectedDate, onDismiss = { showPicker = false }) {
            showPicker = false
            onDateChange(it)
        }
    }
    // Resolve stay names once per day so rows and the places section agree.
    LaunchedEffect(timeline) {
        timeline.activities.filter { it.kind == TimelineActivityKind.STAY }.forEach { stay ->
            val coordinate = stay.coordinate ?: return@forEach
            if (stay.id !in placeLabels) resolveStayPlaceLabel(context, coordinate)?.let { onLabel(stay.id, it) }
        }
    }
}

@Composable
private fun DayHeader(selectedDate: String, onDateChange: (String) -> Unit, onOpenPicker: () -> Unit) {
    val today = dayKey(System.currentTimeMillis())
    val isToday = selectedDate >= today
    Row(Modifier.fillMaxWidth().height(56.dp).padding(start = 12.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).clip(MaterialTheme.shapes.medium).clickable(onClickLabel = "日付を選択", onClick = onOpenPicker).padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text(formatDayTitle(selectedDate), style = MaterialTheme.typography.titleLarge, color = AppColors.ink, maxLines = 1)
                Text(formatDaySubtitle(selectedDate), style = MaterialTheme.typography.labelMedium, color = AppColors.inkSecondary)
            }
            Icon(Icons.Outlined.ExpandMore, null, tint = AppColors.inkSecondary, modifier = Modifier.padding(start = 4.dp).size(20.dp))
        }
        if (!isToday) {
            TextButton(onClick = { onDateChange(today) }, contentPadding = PaddingValues(horizontal = 12.dp)) { Text("今日") }
        }
        IconButton(onClick = { onDateChange(shiftDay(selectedDate, -1)) }) {
            Icon(Icons.Outlined.ChevronLeft, "前の日", tint = AppColors.ink)
        }
        IconButton(onClick = { onDateChange(shiftDay(selectedDate, 1)) }, enabled = !isToday) {
            Icon(Icons.Outlined.ChevronRight, "次の日", tint = if (isToday) AppColors.outlineStrong else AppColors.ink)
        }
    }
}

@Composable
private fun DaySummaryRow(summary: DaySummary, loaded: Boolean) {
    Row(
        Modifier.fillMaxWidth().height(46.dp).padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            !loaded -> Text("読み込み中…", style = MaterialTheme.typography.bodyMedium, color = AppColors.inkTertiary)
            summary.isEmpty -> Text("記録はありません", style = MaterialTheme.typography.bodyMedium, color = AppColors.inkTertiary)
            else -> {
                if (summary.distanceMeters >= 1.0) SummaryChip(Icons.Outlined.Route, AppColors.teal, formatDistance(summary.distanceMeters))
                if (summary.stayCount > 0) SummaryChip(Icons.Outlined.Place, AppColors.green, "滞在 ${summary.stayCount}")
                if (summary.photoCount + summary.videoCount > 0) {
                    SummaryChip(Icons.Outlined.PhotoCamera, AppColors.amber, "${summary.photoCount + summary.videoCount}")
                }
            }
        }
    }
}

@Composable
internal fun SummaryChip(icon: ImageVector, tint: Color, text: String) {
    Row(
        Modifier.height(32.dp).background(AppColors.surfaceMuted, MaterialTheme.shapes.small).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(16.dp))
        Text(text, style = MaterialTheme.typography.labelLarge.tabular, color = AppColors.ink)
    }
}

// Row geometry shared by every timeline entry so the rail stays continuous:
// 44dp time column, 8dp gap, 32dp badge column (rail at its center), 8dp gap.
private val TimeColumnWidth = 44.dp
private val RailX = TimeColumnWidth + 8.dp + 16.dp
private val RowCenterY = 24.dp

@Composable
private fun TimelineRowFrame(
    startedAt: Long,
    endedAt: Long?,
    isFirst: Boolean,
    isLast: Boolean,
    badge: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .drawBehind {
                val x = RailX.toPx()
                val top = if (isFirst) RowCenterY.toPx() else 0f
                val bottom = if (isLast) RowCenterY.toPx() else size.height
                if (bottom > top) drawLine(AppColors.outline, Offset(x, top), Offset(x, bottom), strokeWidth = 2.dp.toPx())
            },
    ) {
        Column(Modifier.width(TimeColumnWidth).padding(top = 16.dp), horizontalAlignment = Alignment.End) {
            Text(formatTime(startedAt), style = MaterialTheme.typography.labelMedium.tabular, color = AppColors.ink, maxLines = 1)
            endedAt?.let { Text(formatTime(it), style = MaterialTheme.typography.labelSmall.tabular, color = AppColors.inkTertiary, maxLines = 1) }
        }
        Spacer(Modifier.width(8.dp))
        Box(Modifier.padding(top = 8.dp)) { badge() }
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f).padding(vertical = 4.dp)) { content() }
    }
}

@Composable
private fun RowCard(selected: Boolean, selectedColor: Color, onClick: () -> Unit, content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(if (selected) selectedColor else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) { content() }
}

@Composable
private fun RowTitle(title: String, trailing: String?) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = AppColors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        trailing?.let { Text(it, style = MaterialTheme.typography.labelMedium.tabular, color = AppColors.inkSecondary, modifier = Modifier.padding(start = 8.dp)) }
    }
}

@Composable
internal fun RowSubtitle(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = AppColors.inkSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
}

@Composable
private fun ActivityRow(
    activity: TimelineActivity,
    label: StayPlaceLabel?,
    isFirst: Boolean,
    isLast: Boolean,
    selected: Boolean,
    photos: List<LibraryPhoto>,
    onLabel: (StayPlaceLabel) -> Unit,
    onClick: () -> Unit,
    onSelectPhotos: (List<LogEntry>) -> Unit,
    onOpenHistory: () -> Unit,
) {
    val isStay = activity.kind == TimelineActivityKind.STAY
    TimelineRowFrame(
        startedAt = activity.startedAt,
        endedAt = activity.endedAt,
        isFirst = isFirst,
        isLast = isLast,
        badge = {
            if (isStay) IconBadge(Icons.Outlined.Place, AppColors.green, AppColors.greenContainer)
            else IconBadge(Icons.Outlined.Route, AppColors.teal, AppColors.tealContainer)
        },
    ) {
        RowCard(selected, if (isStay) AppColors.greenContainer else AppColors.tealContainer, onClick) {
            if (isStay) {
                RowTitle(label?.primary ?: "滞在", activityDurationLabel(activity.durationMs))
                label?.address?.takeIf { it != label.primary }?.let { RowSubtitle(it) }
            } else {
                RowTitle("移動", activityDurationLabel(activity.durationMs))
                RowSubtitle(formatDistance(activity.distanceMeters))
            }
            if (activity.photos.isNotEmpty()) PhotoStrip(activity.photos, photos) { onSelectPhotos(activity.photos) }
            if (isStay && selected) {
                TextButton(onClick = onOpenHistory, contentPadding = PaddingValues(horizontal = 12.dp), modifier = Modifier.padding(top = 6.dp).offset(x = (-12).dp)) {
                    Icon(Icons.Outlined.History, null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("この場所の訪問履歴")
                }
            }
        }
    }
}

@Composable
private fun PhotoGroupRow(entries: List<LogEntry>, isFirst: Boolean, isLast: Boolean, photos: List<LibraryPhoto>, onClick: () -> Unit) {
    TimelineRowFrame(
        startedAt = entries.first().startedAt,
        endedAt = entries.last().startedAt.takeIf { formatTime(it) != formatTime(entries.first().startedAt) },
        isFirst = isFirst,
        isLast = isLast,
        badge = { IconBadge(Icons.Outlined.PhotoCamera, AppColors.amber, AppColors.amberContainer) },
    ) {
        RowCard(selected = false, selectedColor = Color.Transparent, onClick = onClick) {
            RowTitle(mediaSummary(entries), null)
            if (entries.none { hasUsableCoordinates(it.latitude, it.longitude) }) RowSubtitle("位置情報なし")
            PhotoStrip(entries, photos, onClick)
        }
    }
}

@Composable
private fun PhotoStrip(entries: List<LogEntry>, photos: List<LibraryPhoto>, onOpen: () -> Unit) {
    val visible = entries.take(4)
    val hidden = entries.drop(visible.size).sumOf { it.photoCount }
    Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        visible.forEachIndexed { index, entry ->
            PhotoThumbnail(entry, nearestLibraryPhoto(entry, photos), Modifier.size(52.dp), overlay = if (index == visible.lastIndex && hidden > 0) "+$hidden" else null, onClick = onOpen)
        }
    }
}

@Composable
internal fun PhotoThumbnail(entry: LogEntry, libraryPhoto: LibraryPhoto?, modifier: Modifier, overlay: String? = null, requestSize: Int = 128, onClick: () -> Unit) {
    val context = LocalContext.current
    var thumbnail by remember(entry.id, libraryPhoto?.id) { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(entry.id, libraryPhoto) {
        thumbnail = withContext(Dispatchers.IO) { libraryPhoto?.let { PhotoLibrary.loadThumbnail(context, it, requestSize) } }
            ?: runCatching { PhotoBackup.remoteThumbnail(entry.id) }.getOrNull()
    }
    val isVideo = entry.mediaType == MediaType.VIDEO
    Box(modifier.clip(MaterialTheme.shapes.small).background(AppColors.amberContainer).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        thumbnail?.let { Image(it.asImageBitmap(), if (isVideo) "動画" else "写真", Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
            ?: Icon(Icons.Outlined.PhotoCamera, if (isVideo) "動画" else "写真", tint = AppColors.amber, modifier = Modifier.size(20.dp))
        if (isVideo) Icon(Icons.Outlined.PlayCircle, null, tint = Color.White, modifier = Modifier.align(Alignment.BottomStart).padding(4.dp).size(16.dp))
        overlay?.let {
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) {
                Text(it, style = MaterialTheme.typography.labelLarge.tabular, color = Color.White)
            }
        }
    }
}

private fun LazyListScope.stayPlacesSection(
    places: List<StayPlace>,
    labels: Map<String, StayPlaceLabel>,
    expanded: Boolean,
    onToggle: () -> Unit,
    onLabel: (String, StayPlaceLabel) -> Unit,
    onOpenHistory: (PlaceHistoryTarget) -> Unit,
) {
    item(key = "places-header") {
        Column(Modifier.padding(top = 12.dp)) {
            HorizontalDivider(Modifier.padding(horizontal = 20.dp), color = AppColors.outline)
            Row(
                Modifier.fillMaxWidth().clickable(onClickLabel = if (expanded) "閉じる" else "開く", onClick = onToggle).padding(start = 20.dp, end = 16.dp, top = 14.dp, bottom = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("滞在した場所", style = MaterialTheme.typography.titleSmall, color = AppColors.ink)
                    Text("${places.size}か所 · 100m以内の滞在は同じ場所にまとめています", style = MaterialTheme.typography.bodySmall, color = AppColors.inkSecondary)
                }
                Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, tint = AppColors.inkSecondary)
            }
        }
    }
    if (!expanded) return
    val ordered = places.sortedWith(compareByDescending<StayPlace> { it.visitCount }.thenByDescending { it.totalDurationMs })
    items(ordered, key = { "place:${it.id}" }) { place ->
        val label = labels["place:${place.id}"]
        StayPlaceRow(place, label, onLabel = { onLabel("place:${place.id}", it) }) { onOpenHistory(PlaceHistoryTarget(place.coordinate, label)) }
    }
}

@Composable
private fun StayPlaceRow(place: StayPlace, label: StayPlaceLabel?, onLabel: (StayPlaceLabel) -> Unit, onClick: () -> Unit) {
    val context = LocalContext.current
    // Lazily resolved, so only places scrolled into view hit the geocoder.
    LaunchedEffect(place.id, place.coordinate) {
        if (label == null) resolveStayPlaceLabel(context, place.coordinate)?.let(onLabel)
    }
    Row(
        Modifier.fillMaxWidth().clickable(onClickLabel = "訪問履歴を表示", onClick = onClick).padding(start = 20.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconBadge(Icons.Outlined.Place, AppColors.green, AppColors.greenContainer)
        Column(Modifier.weight(1f)) {
            Text(label?.primary ?: formatCoordinates(place.coordinate.latitude, place.coordinate.longitude), style = MaterialTheme.typography.titleSmall, color = AppColors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            label?.address?.takeIf { it != label.primary }?.let { RowSubtitle(it) }
            Text(
                "${place.visitCount}回 · 合計${activityDurationLabel(place.totalDurationMs)} · ${place.visits.joinToString(" / ") { formatTime(it.startedAt) }}",
                style = MaterialTheme.typography.labelMedium.tabular,
                color = AppColors.inkTertiary,
                maxLines = 2,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        Icon(Icons.Outlined.ChevronRight, null, tint = AppColors.inkTertiary)
    }
}

@Composable
private fun EmptyTimeline(autoCapture: Boolean) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        IconBadge(Icons.Outlined.EventBusy, AppColors.inkSecondary, AppColors.surfaceMuted, size = 56.dp, iconSize = 28.dp)
        Text("この日の記録はありません", style = MaterialTheme.typography.titleSmall, color = AppColors.ink, modifier = Modifier.padding(top = 16.dp))
        Text(
            if (autoCapture) "移動や滞在、撮影した写真がここに並びます。" else "設定で位置情報の記録をオンにすると、移動や滞在がここに並びます。",
            style = MaterialTheme.typography.bodySmall,
            color = AppColors.inkSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}

/**
 * A place whose revisits are shown, with its already resolved label if any.
 * [visits] is set when the place comes from the all-places map, so the sheet
 * shows exactly the visits grouped into that place.
 */
internal data class PlaceHistoryTarget(val coordinate: LatLng, val label: StayPlaceLabel?, val visits: List<StaySummary>? = null)

/** All-time visits to one place, grouped by day. Tapping a day opens it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PlaceHistorySheet(history: StayVisitHistory?, target: PlaceHistoryTarget, onDismiss: () -> Unit, onOpenDay: (String) -> Unit) {
    val days = remember(history) { history?.visits.orEmpty().groupBy { dayKey(it.startedAt) }.toList() }
    val maxListHeight = with(LocalDensity.current) { (LocalWindowInfo.current.containerSize.height * 0.6f).toDp() }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = AppColors.surface,
        dragHandle = { SheetHandle() },
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("訪問履歴", style = MaterialTheme.typography.headlineSmall, color = AppColors.ink)
                Text(
                    "${target.label?.primary ?: formatCoordinates(target.coordinate.latitude, target.coordinate.longitude)} · 100m以内の滞在",
                    style = MaterialTheme.typography.bodySmall,
                    color = AppColors.inkSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, "閉じる", tint = AppColors.ink) }
        }
        val loaded = history
        if (loaded == null) {
            Box(Modifier.fillMaxWidth().padding(vertical = 32.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(24.dp), color = AppColors.green, strokeWidth = 2.dp)
            }
            return@ModalBottomSheet
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SummaryChip(Icons.Outlined.Place, AppColors.green, "${loaded.visits.size}回")
            SummaryChip(Icons.Outlined.CalendarMonth, AppColors.teal, "${loaded.dayCount}日")
            SummaryChip(Icons.Outlined.History, AppColors.amber, "合計${activityDurationLabel(loaded.totalDurationMs)}")
        }
        loaded.visits.lastOrNull()?.let { first ->
            Text(
                "${formatDate(dayKey(first.startedAt))}から記録",
                style = MaterialTheme.typography.labelMedium,
                color = AppColors.inkTertiary,
                modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 4.dp),
            )
        }
        LazyColumn(
            Modifier.fillMaxWidth().heightIn(max = maxListHeight),
            contentPadding = PaddingValues(bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 16.dp),
        ) {
            items(days, key = { it.first }) { (day, visits) ->
                Row(
                    Modifier.fillMaxWidth().clickable(onClickLabel = "この日を表示") { onOpenDay(day) }.padding(start = 20.dp, end = 16.dp, top = 10.dp, bottom = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(formatDate(day), style = MaterialTheme.typography.titleSmall, color = AppColors.ink)
                        visits.forEach { visit ->
                            RowSubtitle("${formatTime(visit.startedAt)}–${formatTime(visit.endedAt)} · ${activityDurationLabel(visit.durationMs)}")
                        }
                    }
                    Icon(Icons.Outlined.ChevronRight, null, tint = AppColors.inkTertiary)
                }
            }
        }
    }
}
