package com.remo.app

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoFixHigh
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.EditLocationAlt
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.ImageNotSupported
import androidx.compose.material.icons.outlined.LocationOff
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.Restore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.foundation.text.KeyboardOptions
import com.google.android.gms.maps.model.LatLng
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Locale

private data class DisplayPhoto(val entry: LogEntry, val digest: String? = null) {
    val key: String get() = "${entry.id}:${digest ?: "local"}"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PhotoListSheet(entries: List<LogEntry>, photos: List<LibraryPhoto>, onDismiss: () -> Unit, onEditLocation: (LogEntry) -> Unit) {
    var selectedPhoto by remember { mutableStateOf<DisplayPhoto?>(null) }
    var remoteIDs by remember { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false)
    val maxGridHeight = with(LocalDensity.current) { (LocalWindowInfo.current.containerSize.height * 0.7f).toDp() }
    val sorted = remember(entries) { entries.sortedBy(LogEntry::startedAt) }
    LaunchedEffect(sorted) {
        for (entry in sorted) {
            val ids = runCatching { PhotoBackup.remoteIDs(entry.id) }.getOrDefault(emptyList())
            remoteIDs = remoteIDs + (entry.id to ids)
        }
    }
    val displayed = sorted.flatMap { entry ->
        remoteIDs[entry.id]?.takeIf { it.isNotEmpty() }?.map { DisplayPhoto(entry, it) }
            ?: listOf(DisplayPhoto(entry))
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = AppColors.surface,
        dragHandle = { SheetHandle() },
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("写真と動画", style = MaterialTheme.typography.headlineSmall, color = AppColors.ink)
                val first = sorted.first().startedAt
                val last = sorted.last().startedAt
                val range = if (formatTime(first) == formatTime(last)) formatTime(first) else "${formatTime(first)}–${formatTime(last)}"
                Text("${mediaSummary(sorted)} · $range", style = MaterialTheme.typography.bodySmall, color = AppColors.inkSecondary)
            }
            IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, "閉じる", tint = AppColors.ink) }
        }
        LazyVerticalGrid(
            columns = GridCells.Fixed(3),
            modifier = Modifier.fillMaxWidth().heightIn(max = maxGridHeight).padding(horizontal = 16.dp),
            contentPadding = PaddingValues(bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            items(displayed, key = DisplayPhoto::key) { item ->
                PhotoGridTile(item.entry, nearestLibraryPhoto(item.entry, photos), item.digest) { selectedPhoto = item }
            }
        }
    }
    selectedPhoto?.let { selected ->
        PhotoViewerDialog(selected.entry, nearestLibraryPhoto(selected.entry, photos), selected.digest, { selectedPhoto = null }) {
            selectedPhoto = null; onEditLocation(selected.entry)
        }
    }
}

@Composable
private fun PhotoGridTile(entry: LogEntry, libraryPhoto: LibraryPhoto?, digest: String?, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().aspectRatio(1f)) {
        if (digest == null) PhotoThumbnail(entry, libraryPhoto, Modifier.fillMaxSize(), requestSize = 256, onClick = onClick)
        else {
            var image by remember(entry.id, digest) { mutableStateOf<Bitmap?>(null) }
            LaunchedEffect(entry.id, digest) { image = runCatching { PhotoBackup.remoteImage(entry.id, digest) }.getOrNull() }
            Box(Modifier.fillMaxSize().background(AppColors.amberContainer).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
                image?.let { Image(it.asImageBitmap(), "写真", Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
                    ?: Icon(Icons.Outlined.ImageNotSupported, "写真", tint = AppColors.amber)
            }
        }
        Box(
            Modifier.align(Alignment.BottomStart).fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.5f))), MaterialTheme.shapes.small)
                .padding(horizontal = 8.dp, vertical = 6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(formatTime(entry.startedAt), style = MaterialTheme.typography.labelMedium.tabular, color = Color.White)
                Spacer(Modifier.weight(1f))
                if (entry.photoCount > 1) Text("${entry.photoCount}", style = MaterialTheme.typography.labelSmall.tabular, color = Color.White.copy(alpha = 0.85f))
            }
        }
    }
}

@Composable
private fun PhotoViewerDialog(entry: LogEntry, libraryPhoto: LibraryPhoto?, digest: String?, onDismiss: () -> Unit, onEditLocation: () -> Unit) {
    val context = LocalContext.current
    var image by remember(entry.id, digest, libraryPhoto?.id) { mutableStateOf<Bitmap?>(null) }
    var loading by remember(entry.id, digest, libraryPhoto?.id) { mutableStateOf(true) }
    LaunchedEffect(entry.id, digest, libraryPhoto) {
        image = if (digest != null) runCatching { PhotoBackup.remoteImage(entry.id, digest) }.getOrNull()
            else withContext(Dispatchers.IO) { libraryPhoto?.let { PhotoLibrary.loadThumbnail(context, it, 1800) } }
                ?: runCatching { PhotoBackup.remoteThumbnail(entry.id) }.getOrNull()
        loading = false
    }
    val isVideo = entry.mediaType == MediaType.VIDEO
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        StatusBarIcons(darkIcons = false)
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            when {
                image != null -> Image(image!!.asImageBitmap(), if (isVideo) "動画" else "写真", Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                loading -> CircularProgressIndicator(Modifier.align(Alignment.Center).size(32.dp), color = Color.White, strokeWidth = 2.dp)
                else -> Column(Modifier.align(Alignment.Center).padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Outlined.ImageNotSupported, null, tint = Color.White.copy(alpha = 0.6f), modifier = Modifier.size(40.dp))
                    Text("端末の写真ライブラリに見つかりません", style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = 0.8f), modifier = Modifier.padding(top = 12.dp))
                    Text("撮影日時と位置の記録だけが残っています", style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.6f), modifier = Modifier.padding(top = 4.dp))
                }
            }
            if (isVideo && image != null) Icon(Icons.Outlined.PlayCircle, "動画", tint = Color.White.copy(alpha = 0.9f), modifier = Modifier.align(Alignment.Center).size(56.dp))
            Row(
                Modifier.align(Alignment.TopStart).fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.6f), Color.Transparent)))
                    .statusBarsPadding().padding(start = 4.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, "閉じる", tint = Color.White) }
                Column(Modifier.padding(start = 4.dp)) {
                    Text(formatDayTime(entry.startedAt), style = MaterialTheme.typography.titleSmall, color = Color.White)
                    Text(mediaCountLabel(entry), style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.7f))
                }
            }
            Row(
                Modifier.align(Alignment.BottomStart).fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.6f))))
                    .navigationBarsPadding().padding(start = 20.dp, end = 16.dp, top = 24.dp, bottom = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(formatCoordinates(entry), style = MaterialTheme.typography.bodySmall.tabular, color = Color.White.copy(alpha = 0.75f), modifier = Modifier.weight(1f))
                Button(
                    onClick = onEditLocation,
                    colors = ButtonDefaults.buttonColors(containerColor = Color.White.copy(alpha = 0.16f), contentColor = Color.White),
                    contentPadding = PaddingValues(start = 12.dp, end = 16.dp),
                ) {
                    Icon(Icons.Outlined.EditLocationAlt, null, Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text("位置を補正")
                }
            }
        }
    }
}

@Composable
internal fun DetailDialog(entry: LogEntry, logs: List<LogEntry>, onDismiss: () -> Unit, onUpdate: (LogEntry) -> Unit, onDelete: () -> Unit) {
    if (entry.source == EventSource.PHOTO) {
        PhotoLocationDialog(entry, logs, onDismiss, onUpdate, onDelete)
        return
    }
    var confirmDelete by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("位置の記録", style = MaterialTheme.typography.dialogTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(formatDateTime(entry.startedAt), style = MaterialTheme.typography.bodyMedium, color = AppColors.ink)
                Text(formatCoordinates(entry), style = MaterialTheme.typography.bodySmall.tabular, color = AppColors.inkSecondary)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
        dismissButton = { TextButton(onClick = { confirmDelete = true }) { Text("削除", color = AppColors.danger) } },
    )
    if (confirmDelete) ConfirmDeleteDialog("この位置の記録を削除しますか？", "この操作は元に戻せません。", { confirmDelete = false }, onDelete)
}

@Composable
internal fun ConfirmDeleteDialog(title: String, message: String, onDismiss: () -> Unit, onConfirm: () -> Unit, confirmLabel: String = "削除する") {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Outlined.DeleteOutline, null, tint = AppColors.danger) },
        title = { Text(title, textAlign = TextAlign.Center, style = MaterialTheme.typography.dialogTitle) },
        text = { Text(message, style = MaterialTheme.typography.bodyMedium, color = AppColors.inkSecondary) },
        confirmButton = { TextButton(onClick = { onDismiss(); onConfirm() }) { Text(confirmLabel, color = AppColors.danger) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}

private fun locationSourceLabel(entry: LogEntry): String = when {
    !hasUsableCoordinates(entry.latitude, entry.longitude) -> "位置情報なし"
    entry.locationSource == PhotoLocationSource.INFERRED -> "位置ログから補正済み"
    entry.locationSource == PhotoLocationSource.MANUAL -> "手動で補正済み"
    else -> "撮影時の位置"
}

private fun editableCoordinate(value: Double?): String = value?.let { "%.6f".format(Locale.US, it) }.orEmpty()

@Composable
private fun PhotoLocationDialog(entry: LogEntry, logs: List<LogEntry>, onDismiss: () -> Unit, onUpdate: (LogEntry) -> Unit, onDelete: () -> Unit) {
    var latitudeText by remember(entry.id, entry.latitude) { mutableStateOf(editableCoordinate(entry.latitude)) }
    var longitudeText by remember(entry.id, entry.longitude) { mutableStateOf(editableCoordinate(entry.longitude)) }
    var showManualInput by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val coordinate = draftCoordinate(latitudeText, longitudeText)
    val current = if (hasUsableCoordinates(entry.latitude, entry.longitude)) LatLng(entry.latitude!!, entry.longitude!!) else null
    val original = if (hasUsableCoordinates(entry.originalLatitude, entry.originalLongitude)) LatLng(entry.originalLatitude!!, entry.originalLongitude!!) else null
    val suggestion = remember(entry, logs) { if (entry.locationSource == PhotoLocationSource.INFERRED || entry.photoLocationAutoPlacementDisabled) null else suggestPhotoLocation(entry, logs) }
    val changed = coordinate != null && (current == null || editableCoordinate(coordinate.latitude) != editableCoordinate(current.latitude) || editableCoordinate(coordinate.longitude) != editableCoordinate(current.longitude))

    fun save(nextCoordinate: LatLng?, source: PhotoLocationSource) {
        val originalCoordinate = original ?: current
        onUpdate(entry.copy(
            latitude = nextCoordinate?.latitude,
            longitude = nextCoordinate?.longitude,
            originalLatitude = originalCoordinate?.latitude,
            originalLongitude = originalCoordinate?.longitude,
            locationSource = source,
            photoLocationAutoPlacementDisabled = source == PhotoLocationSource.EXIF,
            updatedAt = System.currentTimeMillis(),
        ))
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize(), color = AppColors.background) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 4.dp, end = 16.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, "閉じる", tint = AppColors.ink) }
                    Column(Modifier.padding(start = 4.dp)) {
                        Text("写真の位置", style = MaterialTheme.typography.titleLarge, color = AppColors.ink)
                        Text("${formatDayTime(entry.startedAt)} · ${mediaCountLabel(entry)}", style = MaterialTheme.typography.bodySmall, color = AppColors.inkSecondary)
                    }
                }
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    LocationPicker(coordinate, Modifier.padding(top = 8.dp)) { selected ->
                        latitudeText = editableCoordinate(selected.latitude)
                        longitudeText = editableCoordinate(selected.longitude)
                    }
                    Column(Modifier.padding(horizontal = 4.dp)) {
                        Text(locationSourceLabel(entry), style = MaterialTheme.typography.titleSmall, color = AppColors.ink)
                        Text(formatCoordinates(entry), style = MaterialTheme.typography.bodySmall.tabular, color = AppColors.inkSecondary)
                        if (original != null && original != current) {
                            Text("撮影時の位置  ${formatCoordinates(original.latitude, original.longitude)}", style = MaterialTheme.typography.bodySmall.tabular, color = AppColors.inkTertiary, modifier = Modifier.padding(top = 2.dp))
                        }
                    }
                    suggestion?.let { candidate ->
                        Row(
                            Modifier.fillMaxWidth().background(AppColors.greenContainer, MaterialTheme.shapes.large).padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Icon(Icons.Outlined.AutoFixHigh, null, tint = AppColors.green, modifier = Modifier.size(24.dp))
                            Column(Modifier.weight(1f)) {
                                Text("位置ログから候補があります", style = MaterialTheme.typography.titleSmall, color = AppColors.onGreenContainer)
                                Text("撮影の${formatSuggestionTime(candidate.timeDistanceMs)} · ${formatSuggestionDistance(candidate.distanceFromOriginalMeters)}", style = MaterialTheme.typography.bodySmall, color = AppColors.inkSecondary)
                            }
                            TextButton(onClick = {
                                latitudeText = editableCoordinate(candidate.latitude)
                                longitudeText = editableCoordinate(candidate.longitude)
                                save(LatLng(candidate.latitude, candidate.longitude), PhotoLocationSource.INFERRED)
                            }) { Text("適用") }
                        }
                    }
                    Surface(shape = MaterialTheme.shapes.large, color = AppColors.surface) {
                        Column {
                            ActionRow(if (showManualInput) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, "緯度・経度を入力") { showManualInput = !showManualInput }
                            if (showManualInput) {
                                Row(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedTextField(latitudeText, { latitudeText = it }, label = { Text("緯度") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
                                    OutlinedTextField(longitudeText, { longitudeText = it }, label = { Text("経度") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
                                }
                                if (coordinate == null && (latitudeText.isNotBlank() || longitudeText.isNotBlank())) {
                                    Text("緯度・経度を数値で入力してください", style = MaterialTheme.typography.bodySmall, color = AppColors.danger, modifier = Modifier.padding(start = 16.dp, bottom = 12.dp))
                                }
                            }
                            if (original != null && entry.locationSource != PhotoLocationSource.EXIF) {
                                HorizontalDivider(Modifier.padding(start = 56.dp), color = AppColors.outline)
                                ActionRow(Icons.Outlined.Restore, "撮影時の位置に戻す") {
                                    latitudeText = editableCoordinate(original.latitude)
                                    longitudeText = editableCoordinate(original.longitude)
                                    save(original, PhotoLocationSource.EXIF)
                                }
                            }
                            if (current != null) {
                                HorizontalDivider(Modifier.padding(start = 56.dp), color = AppColors.outline)
                                ActionRow(Icons.Outlined.LocationOff, "位置情報を削除") { save(null, PhotoLocationSource.REMOVED) }
                            }
                            HorizontalDivider(Modifier.padding(start = 56.dp), color = AppColors.outline)
                            ActionRow(Icons.Outlined.DeleteOutline, "この写真の記録を削除", tint = AppColors.danger) { confirmDelete = true }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                }
                Surface(color = AppColors.surface, shadowElevation = 8.dp) {
                    Button(
                        onClick = { save(coordinate, PhotoLocationSource.MANUAL) },
                        enabled = changed,
                        modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp).height(48.dp),
                    ) { Text("この位置で保存") }
                }
            }
        }
    }
    if (confirmDelete) {
        ConfirmDeleteDialog("この写真の記録を削除しますか？", "Remoのタイムラインから削除します。端末の写真そのものは削除されません。", { confirmDelete = false }, onDelete)
    }
}

@Composable
internal fun ActionRow(icon: ImageVector, title: String, tint: Color = AppColors.green, subtitle: String? = null, trailing: (@Composable () -> Unit)? = null, onClick: (() -> Unit)?) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(24.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = if (tint == AppColors.danger) AppColors.danger else AppColors.ink)
            subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = AppColors.inkSecondary, modifier = Modifier.padding(top = 2.dp)) }
        }
        trailing?.invoke()
    }
}

private fun draftCoordinate(latitudeText: String, longitudeText: String): LatLng? {
    val latitude = latitudeText.trim().toDoubleOrNull()
    val longitude = longitudeText.trim().toDoubleOrNull()
    return if (hasUsableCoordinates(latitude, longitude)) LatLng(latitude!!, longitude!!) else null
}

private fun formatSuggestionTime(value: Long): String {
    val minutes = value / 60_000L
    return if (minutes < 1) "1分以内" else "約${minutes}分以内"
}

private fun formatSuggestionDistance(value: Double?): String = when {
    value == null -> "元の位置との距離は不明"
    value < 1_000 -> "元の位置から約${value.toInt()}m"
    else -> "元の位置から約${"%.1f".format(Locale.US, value / 1_000)}km"
}
