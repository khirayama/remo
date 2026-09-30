package com.remo.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.MyLocation
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.ZoomOutMap
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.GoogleMap
import com.google.android.gms.maps.model.BitmapDescriptor
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.MapStyleOptions
import com.google.android.gms.maps.model.MarkerOptions
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

/** Which map the home screen shows: one day's timeline or every place ever stayed at. */
internal enum class HomeMode { DAY, ALL }

internal enum class PlacePeriod(val label: String, val days: Int?) {
    ALL("全期間", null),
    YEAR("1年", 365),
    MONTH("30日", 30),
}

internal fun staysInPeriod(stays: List<StaySummary>, period: PlacePeriod, now: Long = System.currentTimeMillis()): List<StaySummary> {
    val days = period.days ?: return stays
    val from = now - days * 86_400_000L
    return stays.filter { it.startedAt >= from }
}

/** The all-places camera survives a visit to a day and back. */
internal class SavedCamera {
    var position: CameraPosition? = null
}

@Composable
internal fun ModeToggle(mode: HomeMode, onChange: (HomeMode) -> Unit) {
    Surface(shape = CircleShape, color = AppColors.surface, shadowElevation = 3.dp) {
        Row(Modifier.padding(3.dp)) {
            listOf(HomeMode.DAY to "日ごと", HomeMode.ALL to "すべて").forEach { (value, label) ->
                val selected = mode == value
                Text(
                    label,
                    style = MaterialTheme.typography.labelLarge,
                    color = if (selected) AppColors.onGreenContainer else AppColors.inkSecondary,
                    modifier = Modifier.clip(CircleShape)
                        .background(if (selected) AppColors.greenContainer else AppColors.surface)
                        .clickable(onClickLabel = label) { onChange(value) }
                        .padding(horizontal = 14.dp, vertical = 7.dp),
                )
            }
        }
    }
}

/** Screen radius of a place in dp: log-scaled so home does not cover the map. */
private fun placeMarkerRadiusDp(totalDurationMs: Long): Float {
    val hours = max(0L, totalDurationMs) / 3_600_000.0
    return min(22.0, 5 + ln(1 + hours) / ln(2.0) * 2.2).toFloat()
}

/** Places visited long ago fade, like the day's route. */
private fun placeMarkerOpacity(lastVisitedAt: Long, now: Long): Float {
    val ageDays = max(0L, now - lastVisitedAt) / 86_400_000.0
    return max(0.12, 0.55 - log10(1 + ageDays) * 0.15).toFloat()
}

private fun placeMarkerBitmap(radiusPx: Float, fillAlpha: Float, selected: Boolean, density: Float): Bitmap {
    val stroke = (if (selected) 3f else 1f) * density
    val size = ((radiusPx + stroke) * 2).toInt().coerceAtLeast(2)
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val center = size / 2f
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.style = Paint.Style.FILL
    paint.color = android.graphics.Color.argb(((if (selected) 0.9f else fillAlpha) * 255).toInt(), 47, 90, 69)
    canvas.drawCircle(center, center, radiusPx, paint)
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = stroke
    paint.color = if (selected) android.graphics.Color.WHITE else android.graphics.Color.argb((min(1f, fillAlpha + 0.3f) * 255).toInt(), 47, 90, 69)
    canvas.drawCircle(center, center, radiusPx, paint)
    return bitmap
}

/**
 * Every place ever stayed at, drawn as screen-sized circles: the size follows
 * the total time there and the shade how recently it was visited.
 */
@Composable
internal fun AllPlacesMap(
    places: List<AllTimeStayPlace>?,
    selectedPlaceId: String?,
    savedCamera: SavedCamera,
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    onSelectPlace: (AllTimeStayPlace) -> Unit,
    overlay: @Composable BoxScope.() -> Unit = {},
) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val layoutDirection = LocalLayoutDirection.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val onSelectPlaceState by rememberUpdatedState(onSelectPlace)
    val padding = with(density) {
        MapPadding(
            contentPadding.calculateStartPadding(layoutDirection).roundToPx(),
            contentPadding.calculateTopPadding().roundToPx(),
            contentPadding.calculateEndPadding(layoutDirection).roundToPx(),
            contentPadding.calculateBottomPadding().roundToPx(),
        )
    }
    val paddingState by rememberUpdatedState(padding)
    val canLocate = hasLocationPermission(context)
    val px = context.resources.displayMetrics.density
    var readyMap by remember { mutableStateOf<GoogleMap?>(null) }
    val fitted = remember { booleanArrayOf(false) }
    val renderedKey = remember { arrayOfNulls<Any>(1) }
    val icons = remember { mutableMapOf<String, BitmapDescriptor>() }
    // Returning from a day keeps the saved camera instead of jumping to the selection.
    val initialSelection = remember { selectedPlaceId }
    val placesById = remember(places) { places.orEmpty().associateBy(AllTimeStayPlace::id) }
    val coordinates = remember(places) { places.orEmpty().map(AllTimeStayPlace::coordinate) }
    val mapView = rememberMapView()

    Box(modifier) {
        AndroidView(factory = { mapView }, modifier = Modifier.fillMaxSize(), update = { view ->
            view.getMapAsync { map ->
                if (view.tag == DESTROYED_TAG) return@getMapAsync
                if (readyMap !== map) {
                    readyMap = map
                    map.uiSettings.isZoomControlsEnabled = false
                    map.uiSettings.isMyLocationButtonEnabled = false
                    map.uiSettings.isMapToolbarEnabled = false
                    runCatching { map.setMapStyle(MapStyleOptions.loadRawResourceStyle(context, R.raw.map_style)) }
                    enableMyLocation(map, context)
                    map.setOnCameraIdleListener { if (fitted[0]) savedCamera.position = map.cameraPosition }
                }
                paddingState.applyTo(map)
                val key = places to selectedPlaceId
                if (places == null || renderedKey[0] == key) return@getMapAsync
                renderedKey[0] = key
                map.clear()
                val now = System.currentTimeMillis()
                places.forEach { place ->
                    val selected = place.id == selectedPlaceId
                    val radius = placeMarkerRadiusDp(place.totalDurationMs) + if (selected) 3f else 0f
                    val opacity = placeMarkerOpacity(place.lastVisitedAt, now)
                    // Quantized so places of a similar size and age share one bitmap.
                    val iconKey = "${(radius * 2).toInt()}:${(opacity * 20).toInt()}:$selected"
                    val icon = icons.getOrPut(iconKey) {
                        BitmapDescriptorFactory.fromBitmap(placeMarkerBitmap((radius * 2).toInt() / 2f * px, (opacity * 20).toInt() / 20f, selected, px))
                    }
                    map.addMarker(
                        MarkerOptions().position(place.coordinate).icon(icon).anchor(0.5f, 0.5f)
                            // Smaller circles on top so a frequent place never hides a rare one nearby.
                            .zIndex(if (selected) 100f else -radius),
                    )?.tag = place.id
                }
                map.setOnMarkerClickListener { marker ->
                    (marker.tag as? String)?.let(placesById::get)?.let { onSelectPlaceState(it) }
                    true
                }
                if (!fitted[0] && places.isNotEmpty()) {
                    val saved = savedCamera.position
                    if (saved != null) map.moveCamera(CameraUpdateFactory.newCameraPosition(saved)) else fitMap(map, coordinates, px)
                    fitted[0] = true
                }
            }
        })
        Row(
            Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(top = 12.dp, end = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (canLocate) {
                MapControlButton(Icons.Outlined.MyLocation, "現在地を表示", enabled = readyMap != null) {
                    readyMap?.let { moveToCurrentLocation(context, it, animate = true) }
                }
            }
            MapControlButton(Icons.Outlined.ZoomOutMap, "すべての滞在場所を表示", enabled = readyMap != null && coordinates.isNotEmpty()) {
                readyMap?.let { fitMap(it, coordinates, px, animate = true) }
            }
        }
        overlay()
    }
    DisposableEffect(mapView, lifecycleOwner) { bindMapLifecycle(mapView, lifecycleOwner.lifecycle) }
    LaunchedEffect(readyMap, padding) { readyMap?.let(padding::applyTo) }
    LaunchedEffect(selectedPlaceId, readyMap) {
        val map = readyMap ?: return@LaunchedEffect
        if (selectedPlaceId == null || selectedPlaceId == initialSelection) return@LaunchedEffect
        val place = placesById[selectedPlaceId] ?: return@LaunchedEffect
        map.animateCamera(CameraUpdateFactory.newLatLngZoom(place.coordinate, maxOf(map.cameraPosition.zoom, 15f)))
    }
}

/** Sheet content of the all-places map: every place ever stayed at, most visited first. */
@Composable
internal fun AllPlacesSheetContent(
    places: List<AllTimeStayPlace>?,
    stays: List<StaySummary>?,
    progress: StayIndexProgress?,
    period: PlacePeriod,
    selectedPlaceId: String?,
    listState: LazyListState,
    bottomPadding: Dp,
    modifier: Modifier = Modifier,
    onPeriodChange: (PlacePeriod) -> Unit,
    onSelectPlace: (AllTimeStayPlace, StayPlaceLabel?) -> Unit,
) {
    var labels by remember { mutableStateOf<Map<String, StayPlaceLabel>>(emptyMap()) }
    val dayCount = remember(stays) { stays.orEmpty().map { dayKey(it.startedAt) }.toSet().size }
    LazyColumn(modifier.fillMaxWidth(), state = listState, contentPadding = PaddingValues(bottom = bottomPadding)) {
        item(key = "header") {
            Row(Modifier.fillMaxWidth().height(56.dp).padding(start = 20.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("滞在した場所", style = MaterialTheme.typography.titleLarge, color = AppColors.ink, maxLines = 1, modifier = Modifier.weight(1f))
                PeriodSelector(period, onPeriodChange)
            }
        }
        item(key = "summary") {
            Row(
                Modifier.fillMaxWidth().height(46.dp).padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                when {
                    places == null || stays == null -> {
                        CircularProgressIndicator(Modifier.size(18.dp), color = AppColors.green, strokeWidth = 2.dp)
                        Text(
                            "過去の記録を集計しています…" + (progress?.takeIf { it.total > 0 }?.let { " ${it.done}/${it.total}日" } ?: ""),
                            style = MaterialTheme.typography.bodyMedium.tabular,
                            color = AppColors.inkSecondary,
                        )
                    }
                    places.isEmpty() -> Text("この期間の滞在はありません", style = MaterialTheme.typography.bodyMedium, color = AppColors.inkTertiary)
                    else -> {
                        SummaryChip(Icons.Outlined.Place, AppColors.green, "${places.size}か所")
                        SummaryChip(Icons.Outlined.CalendarMonth, AppColors.teal, "${dayCount}日")
                        SummaryChip(Icons.Outlined.History, AppColors.amber, "滞在 ${stays.size}回")
                    }
                }
            }
        }
        if (!places.isNullOrEmpty()) {
            item(key = "label") {
                Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    SectionLabel("訪問回数の多い順", Modifier.weight(1f))
                    Text("100m以内は同じ場所", style = MaterialTheme.typography.labelMedium, color = AppColors.inkTertiary)
                }
            }
            items(places, key = { it.id }) { place ->
                AllTimePlaceRow(
                    place = place,
                    label = labels[place.id],
                    selected = place.id == selectedPlaceId,
                    onLabel = { labels = labels + (place.id to it) },
                ) { onSelectPlace(place, labels[place.id]) }
            }
        }
    }
}

@Composable
private fun PeriodSelector(period: PlacePeriod, onChange: (PlacePeriod) -> Unit) {
    Row(Modifier.height(32.dp).clip(CircleShape).background(AppColors.surfaceMuted).padding(2.dp)) {
        PlacePeriod.entries.forEach { value ->
            val selected = value == period
            Box(
                Modifier.fillMaxHeight().clip(CircleShape)
                    .background(if (selected) AppColors.greenContainer else AppColors.surfaceMuted)
                    .clickable(onClickLabel = value.label) { onChange(value) }
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(value.label, style = MaterialTheme.typography.labelMedium, color = if (selected) AppColors.onGreenContainer else AppColors.inkSecondary, maxLines = 1)
            }
        }
    }
}

@Composable
private fun AllTimePlaceRow(place: AllTimeStayPlace, label: StayPlaceLabel?, selected: Boolean, onLabel: (StayPlaceLabel) -> Unit, onClick: () -> Unit) {
    val context = LocalContext.current
    // Lazily resolved, so only places scrolled into view hit the geocoder.
    LaunchedEffect(place.id) {
        if (label == null) resolveStayPlaceLabel(context, place.coordinate)?.let(onLabel)
    }
    Row(
        Modifier.fillMaxWidth()
            .background(if (selected) AppColors.greenContainer else AppColors.surface)
            .clickable(onClickLabel = "訪問履歴を表示", onClick = onClick)
            .padding(start = 20.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconBadge(Icons.Outlined.Place, AppColors.green, AppColors.greenContainer)
        Column(Modifier.weight(1f)) {
            Text(label?.primary ?: formatCoordinates(place.coordinate.latitude, place.coordinate.longitude), style = MaterialTheme.typography.titleSmall, color = AppColors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            label?.address?.takeIf { it != label.primary }?.let { RowSubtitle(it) }
            Text(
                "${place.visits.size}回 · ${place.dayCount}日 · 合計${activityDurationLabel(place.totalDurationMs)} · 最終 ${formatDate(dayKey(place.lastVisitedAt))}",
                style = MaterialTheme.typography.labelMedium.tabular,
                color = AppColors.inkTertiary,
                maxLines = 2,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        Icon(Icons.Outlined.ChevronRight, null, tint = AppColors.inkTertiary)
    }
}
