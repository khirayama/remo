package com.remo.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.MyLocation
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.ZoomOutMap
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.android.gms.location.LocationServices
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.GoogleMap
import com.google.android.gms.maps.MapView
import com.google.android.gms.maps.model.BitmapDescriptor
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.Circle
import com.google.android.gms.maps.model.CircleOptions
import com.google.android.gms.maps.model.JointType
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.LatLngBounds
import com.google.android.gms.maps.model.MapStyleOptions
import com.google.android.gms.maps.model.Marker
import com.google.android.gms.maps.model.MarkerOptions
import com.google.android.gms.maps.model.Dot
import com.google.android.gms.maps.model.Gap
import com.google.android.gms.maps.model.PatternItem
import com.google.android.gms.maps.model.Polyline
import com.google.android.gms.maps.model.PolylineOptions
import com.google.android.gms.maps.model.RoundCap
import com.google.android.gms.maps.model.StrokeStyle
import com.google.android.gms.maps.model.StyleSpan
import com.google.android.gms.maps.model.TextureStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val DEFAULT_CENTER = LatLng(35.6812, 139.7671)

internal data class TimelineMapFocus(
    val activityId: String,
    val kind: TimelineActivityKind,
    val path: List<LatLng>,
) {
    val center: LatLng get() = path.lastOrNull() ?: DEFAULT_CENTER
}

internal fun timelineMapFocus(activity: TimelineActivity): TimelineMapFocus {
    val path = activity.path.ifEmpty { listOfNotNull(activity.coordinate ?: activity.from, activity.to) }
    return TimelineMapFocus(activity.id, activity.kind, path)
}

/**
 * The day's map. [contentPadding] is the part of the map covered by overlays
 * (status bar + controls on top, the bottom sheet below); camera fits and
 * focus moves keep their target inside the remaining visible area.
 */
@Composable
internal fun TimelineMap(
    timeline: TimelineRenderSnapshot,
    loaded: Boolean,
    viewKey: String,
    photos: List<LibraryPhoto>,
    contentPadding: PaddingValues,
    focusTarget: TimelineMapFocus?,
    modifier: Modifier = Modifier,
    onSelectPhotos: (List<LogEntry>) -> Unit,
    overlay: @Composable BoxScope.() -> Unit = {},
) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val layoutDirection = LocalLayoutDirection.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val onSelectPhotosState by rememberUpdatedState(onSelectPhotos)
    val padding = with(density) {
        MapPadding(
            contentPadding.calculateStartPadding(layoutDirection).roundToPx(),
            contentPadding.calculateTopPadding().roundToPx(),
            contentPadding.calculateEndPadding(layoutDirection).roundToPx(),
            contentPadding.calculateBottomPadding().roundToPx(),
        )
    }
    val paddingState by rememberUpdatedState(padding)
    val processedLocations = timeline.processedLocations
    val routeSegments = timeline.routeSegments
    val routeRgb = MapColors.routeRgb
    val replay = remember(routeSegments) { RouteReplay.of(routeSegments) }
    var replaying by remember(viewKey) { mutableStateOf(false) }
    var replayPlaying by remember(viewKey) { mutableStateOf(false) }
    var replayProgress by remember(viewKey) { mutableFloatStateOf(0f) }
    // Picking an activity in the sheet hands the map back to that activity.
    LaunchedEffect(focusTarget, replay) { if (focusTarget != null || replay == null) replaying = false }
    val dimmed = focusTarget != null || replaying
    val routePaths = remember(routeSegments, dimmed) { routeRenderPaths(routeSegments, dimmed) }
    val stayClusters = timeline.stayClusters
    var stayLabels by remember { mutableStateOf<Map<String, StayPlaceLabel>>(emptyMap()) }
    LaunchedEffect(stayClusters) {
        stayLabels = buildMap {
            stayClusters.forEach { stay -> resolveStayPlaceLabel(context, stay.coordinate)?.let { put(stay.id, it) } }
        }
    }
    val photoClusters = timeline.photoClusters
    val photoClustersById = remember(photoClusters) { photoClusters.associateBy(PhotoCluster::id) }
    var photoThumbnails by remember { mutableStateOf<Map<String, Bitmap?>>(emptyMap()) }
    LaunchedEffect(photoClusters, photos) {
        photoThumbnails = buildMap {
            // The marker only displays the first photo in a cluster. Load that
            // local thumbnail first so a large cluster cannot delay the map.
            photoClusters.mapNotNull { it.entries.firstOrNull() }.forEach { log ->
                val photo = nearestLibraryPhoto(log, photos)
                put(log.id, withContext(Dispatchers.IO) { photo?.let { PhotoLibrary.loadThumbnail(context, it, 128) } }
                    ?: runCatching { PhotoBackup.remoteThumbnail(log.id) }.getOrNull())
            }
        }
    }
    val mapLocations: List<LatLng> = remember(processedLocations, stayClusters, photoClusters) {
        buildList {
            addAll(processedLocations.map { LatLng(it.latitude, it.longitude) })
            addAll(stayClusters.map(StayCluster::coordinate))
            addAll(photoClusters.map { LatLng(it.latitude, it.longitude) })
        }
    }
    val canLocate = hasLocationPermission(context)
    var readyMap by remember { mutableStateOf<GoogleMap?>(null) }
    val focusedViewKey = remember { mutableStateOf<String?>(null) }
    val mapRenderKey = remember(viewKey, loaded, routeSegments, routeRgb, stayClusters, stayLabels, photoClusters, photoThumbnails, focusTarget, replaying) {
        MapRenderKey(viewKey, loaded, routeSegments, routeRgb, stayClusters, stayLabels, photoClusters, photoThumbnails, focusTarget, replaying)
    }
    var renderedMapKey by remember { mutableStateOf<MapRenderKey?>(null) }
    var openInfoWindowKey by remember { mutableStateOf<String?>(null) }
    val routeLines = remember { mutableListOf<RenderedRoute>() }
    val stayCircles = remember { mutableMapOf<String, Circle>() }
    val stayInfoMarkers = remember { mutableMapOf<String, Marker>() }
    val renderedStays = remember { mutableMapOf<String, Pair<StayCluster, StayPlaceLabel?>>() }
    val photoMarkers = remember { mutableMapOf<String, Marker>() }
    val renderedPhotos = remember { mutableMapOf<String, Pair<PhotoCluster, Bitmap?>>() }
    val focusLine = remember { arrayOfNulls<Polyline>(1) }
    val replayLine = remember { arrayOfNulls<Polyline>(1) }
    val replayHead = remember { arrayOfNulls<Marker>(1) }
    val chevrons = remember { mutableMapOf<Int, BitmapDescriptor>() }
    val mapView = rememberMapView()
    val px = context.resources.displayMetrics.density

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
                    map.setOnInfoWindowCloseListener { openInfoWindowKey = null }
                    map.setOnMapClickListener { openInfoWindowKey = null }
                }
                if (renderedMapKey != mapRenderKey) {
                    val infoWindowKeyToRestore = openInfoWindowKey
                    paddingState.applyTo(map)
                    if (focusedViewKey.value != viewKey && loaded) {
                        if (mapLocations.isEmpty()) moveToCurrentLocation(context, map) else fitMap(map, mapLocations, px)
                        focusedViewKey.value = viewKey
                    }
                    while (routeLines.size > routePaths.size) routeLines.removeAt(routeLines.lastIndex).remove()
                    val chevron = chevrons.getOrPut(MapColors.focusRouteRgb) { chevronStamp(MapColors.focusRouteRgb, px) }
                    routePaths.forEachIndexed { index, path ->
                        val rendered = routeLines.getOrNull(index)
                        if (rendered == null) {
                            routeLines += RenderedRoute(path, routeRgb, map.addPolyline(
                                PolylineOptions().addAll(path.points).addAllSpans(routeSpans(path, routeRgb)).width(routeWidth(path) * px)
                                    .pattern(routePattern(path, px))
                                    .jointType(JointType.ROUND).startCap(RoundCap()).endCap(RoundCap())
                            ))
                        } else if (rendered.path != path || rendered.rgb != routeRgb) {
                            if (rendered.path.points != path.points) {
                                rendered.line.points = path.points
                                rendered.chevrons?.points = path.points
                            }
                            rendered.line.spans = routeSpans(path, routeRgb)
                            if (rendered.path.untracked != path.untracked) {
                                rendered.line.width = routeWidth(path) * px
                                rendered.line.pattern = routePattern(path, px)
                            }
                            if (rendered.rgb != routeRgb) rendered.chevrons?.let { it.spans = chevronSpans(chevron) }
                            rendered.path = path
                            rendered.rgb = routeRgb
                        }
                        val route = routeLines[index]
                        // Chevrons only on recorded lines: an unrecorded gap has no direction to show.
                        if (!path.untracked && !dimmed) {
                            if (route.chevrons == null) route.chevrons = map.addPolyline(
                                PolylineOptions().addAll(path.points).width(CHEVRON_WIDTH_DP * px).zIndex(1f).addAllSpans(chevronSpans(chevron))
                            )
                        } else {
                            route.chevrons?.remove()
                            route.chevrons = null
                        }
                    }
                    val stayKeys = stayClusters.map { "stay:${it.entries.firstOrNull()?.entry?.id ?: it.id}" }.toSet()
                    (stayCircles.keys - stayKeys).forEach { key ->
                        stayCircles.remove(key)?.remove()
                        stayInfoMarkers.remove(key)?.remove()
                        renderedStays.remove(key)
                    }
                    stayClusters.forEach { stay ->
                        val popupKey = "stay:${stay.entries.firstOrNull()?.entry?.id ?: stay.id}"
                        val selected = focusTarget?.kind == TimelineActivityKind.STAY && focusTarget.activityId == stay.id
                        // A name the user gave to the place replaces the geocoder's.
                        val label = stayLabels[stay.id].named(stay.coordinate)
                        val circle = stayCircles.getOrPut(popupKey) { map.addCircle(CircleOptions().center(stay.coordinate).clickable(true)) }
                        if (renderedStays[popupKey]?.first != stay) circle.center = stay.coordinate
                        circle.applyStayStyle(stay, if (selected) StayCircleState.SELECTED else if (dimmed) StayCircleState.DIMMED else StayCircleState.NORMAL, px)
                        circle.tag = popupKey
                        val stayDetails = listOfNotNull(
                            label?.address?.takeIf { it != label.primary },
                            "${formatTime(stay.startedAt)} – ${formatTime(stay.endedAt)} · ${elapsedStayLabel(stay.durationMs)}",
                        ).joinToString("\n")
                        val marker = stayInfoMarkers[popupKey] ?: map.addMarker(MarkerOptions().position(stay.coordinate).icon(BitmapDescriptorFactory.fromBitmap(Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888))).anchor(0.5f, 0.5f))
                        marker?.let { marker ->
                            marker.tag = popupKey
                            stayInfoMarkers[popupKey] = marker
                            if (renderedStays[popupKey] != (stay to label)) {
                                marker.position = stay.coordinate
                                marker.title = label?.primary ?: "滞在"
                                marker.snippet = stayDetails
                            }
                        }
                        renderedStays[popupKey] = stay to label
                    }
                    val photoKeys = photoClusters.map(PhotoCluster::id).toSet()
                    (photoMarkers.keys - photoKeys).forEach { key -> photoMarkers.remove(key)?.remove(); renderedPhotos.remove(key) }
                    photoClusters.forEach { cluster ->
                        val log = cluster.entries.first()
                        val thumbnail = photoThumbnails[log.id]
                        val marker = photoMarkers[cluster.id] ?: map.addMarker(MarkerOptions().position(LatLng(cluster.latitude, cluster.longitude)).anchor(0.5f, 0.5f).zIndex(3f))
                        marker?.let {
                            photoMarkers[cluster.id] = it
                            it.tag = cluster.id
                            if (renderedPhotos[cluster.id] != (cluster to thumbnail)) {
                                it.position = LatLng(cluster.latitude, cluster.longitude)
                                it.title = mediaSummary(cluster.photoCount, cluster.videoCount)
                                it.setIcon(photoMarkerIcon(context, thumbnail, cluster.photoCount + cluster.videoCount, log.mediaType == MediaType.VIDEO))
                            }
                            it.alpha = if (dimmed) 0.4f else 1f
                        }
                        renderedPhotos[cluster.id] = cluster to thumbnail
                    }
                    if (!replaying && focusTarget?.kind == TimelineActivityKind.MOVEMENT && focusTarget.path.size > 1) {
                        val line = focusLine[0] ?: map.addPolyline(
                            PolylineOptions().width(6 * px).zIndex(2f)
                                .jointType(JointType.ROUND).startCap(RoundCap()).endCap(RoundCap())
                        ).also { focusLine[0] = it }
                        // Spans refer to segments, so the points must be in place first.
                        line.points = focusTarget.path
                        line.spans = listOf(StyleSpan(StrokeStyle.colorBuilder(MapColors.argb(255, MapColors.focusRouteRgb))
                            .stamp(TextureStyle.newBuilder(chevrons.getOrPut(0xFFFFFF) { chevronStamp(0xFFFFFF, px) }).build()).build()))
                    } else {
                        focusLine[0]?.remove()
                        focusLine[0] = null
                    }
                    map.setOnMarkerClickListener { marker ->
                        val id = marker.tag as? String ?: return@setOnMarkerClickListener false
                        val photoCluster = photoClustersById[id]
                        if (photoCluster != null) {
                            onSelectPhotosState(photoCluster.entries)
                            true
                        } else {
                            openInfoWindowKey = id
                            false
                        }
                    }
                    map.setOnCircleClickListener { circle ->
                        val id = circle.tag as? String ?: return@setOnCircleClickListener
                        openInfoWindowKey = id
                        stayInfoMarkers[id]?.showInfoWindow()
                    }
                    stayInfoMarkers[infoWindowKeyToRestore]?.showInfoWindow()
                    renderedMapKey = mapRenderKey
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
            MapControlButton(Icons.Outlined.PlayArrow, "この日をリプレイ", enabled = readyMap != null && replay != null && !replaying) {
                replayProgress = 0f
                replayPlaying = true
                replaying = true
                readyMap?.let { fitMap(it, mapLocations, px, animate = true) }
            }
            MapControlButton(Icons.Outlined.ZoomOutMap, "この日の記録全体を表示", enabled = readyMap != null && mapLocations.isNotEmpty()) {
                readyMap?.let { fitMap(it, mapLocations, px, animate = true) }
            }
        }
        overlay()
        if (replaying && replay != null) {
            ReplayBar(
                time = replay.timeAt(replayProgress),
                progress = replayProgress,
                playing = replayPlaying,
                modifier = Modifier.align(Alignment.BottomCenter).padding(start = 12.dp, end = 12.dp, bottom = contentPadding.calculateBottomPadding() + 12.dp),
                onTogglePlaying = { replayPlaying = !replayPlaying },
                onSeek = { replayPlaying = false; replayProgress = it },
                onClose = { replayPlaying = false; replaying = false },
            )
        }
    }
    LaunchedEffect(replaying, replayPlaying) {
        if (!replaying || !replayPlaying) return@LaunchedEffect
        if (replayProgress >= 1f) replayProgress = 0f
        var last = withFrameNanos { it }
        while (replayProgress < 1f) {
            val now = withFrameNanos { it }
            replayProgress = (replayProgress + (now - last) / 1_000_000f / REPLAY_PLAYBACK_MS).coerceAtMost(1f)
            last = now
        }
        replayPlaying = false
    }
    // Restarts after every full render so the replay's styling wins over it.
    LaunchedEffect(readyMap, replaying, replay, renderedMapKey) {
        val map = readyMap ?: return@LaunchedEffect
        if (!replaying || replay == null) {
            replayLine[0]?.remove()
            replayLine[0] = null
            replayHead[0]?.remove()
            replayHead[0] = null
            return@LaunchedEffect
        }
        snapshotFlow { replayProgress }.collect { progress ->
            val frame = replay.frame(progress)
            val line = replayLine[0] ?: map.addPolyline(
                PolylineOptions().color(MapColors.argb(255, MapColors.focusRouteRgb)).width(6 * px).zIndex(2f)
                    .jointType(JointType.ROUND).startCap(RoundCap()).endCap(RoundCap())
            ).also { replayLine[0] = it }
            line.points = frame.drawn
            val head = replayHead[0] ?: map.addMarker(
                MarkerOptions().position(frame.head).anchor(0.5f, 0.5f).zIndex(4f).icon(replayHeadIcon(px))
            )?.also { replayHead[0] = it }
            head?.position = frame.head
            stayClusters.forEach { stay ->
                val state = when {
                    frame.time < stay.startedAt -> StayCircleState.DIMMED
                    frame.time <= stay.endedAt -> StayCircleState.SELECTED
                    else -> StayCircleState.NORMAL
                }
                stayCircles["stay:${stay.entries.firstOrNull()?.entry?.id ?: stay.id}"]?.applyStayStyle(stay, state, px)
            }
            photoClusters.forEach { cluster ->
                photoMarkers[cluster.id]?.alpha = if (cluster.entries.first().startedAt <= frame.time) 1f else 0.25f
            }
        }
    }
    DisposableEffect(mapView, lifecycleOwner) { bindMapLifecycle(mapView, lifecycleOwner.lifecycle) }
    LaunchedEffect(readyMap, padding) {
        readyMap?.let(padding::applyTo)
    }
    LaunchedEffect(focusTarget, readyMap) {
        val map = readyMap ?: return@LaunchedEffect
        val focus = focusTarget ?: return@LaunchedEffect
        padding.applyTo(map)
        if (focus.path.size > 1) {
            val bounds = LatLngBounds.Builder().apply { focus.path.forEach(::include) }.build()
            runCatching { map.animateCamera(CameraUpdateFactory.newLatLngBounds(bounds, (40 * px).toInt())) }
                .onFailure { map.animateCamera(CameraUpdateFactory.newLatLngZoom(focus.center, 16f)) }
        } else {
            map.animateCamera(CameraUpdateFactory.newLatLngZoom(focus.center, maxOf(map.cameraPosition.zoom, 16f)))
        }
    }
}

internal data class MapPadding(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    fun applyTo(map: GoogleMap) = map.setPadding(left, top, right, bottom)
}

internal const val DESTROYED_TAG = "remo:destroyed"

/** A MapView that forwards touch ownership so parent scrolling containers don't steal drags. */
@Composable
internal fun rememberMapView(): MapView {
    val context = LocalContext.current
    return remember {
        MapView(context).apply {
            onCreate(null)
            setOnTouchListener { view, event ->
                when (event.actionMasked) {
                    android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_MOVE -> view.parent?.requestDisallowInterceptTouchEvent(true)
                    android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> view.parent?.requestDisallowInterceptTouchEvent(false)
                }
                false
            }
        }
    }
}

internal fun androidx.compose.runtime.DisposableEffectScope.bindMapLifecycle(mapView: MapView, lifecycle: Lifecycle): androidx.compose.runtime.DisposableEffectResult {
    val nativeLifecycle = MapLifecycle(mapView::onStart, mapView::onResume, mapView::onPause, mapView::onStop) {
        mapView.tag = DESTROYED_TAG
        mapView.onDestroy()
    }
    val observer = LifecycleEventObserver { _, event ->
        when (event) {
            Lifecycle.Event.ON_START -> nativeLifecycle.start()
            Lifecycle.Event.ON_RESUME -> nativeLifecycle.resume()
            Lifecycle.Event.ON_PAUSE -> nativeLifecycle.pause()
            Lifecycle.Event.ON_STOP -> nativeLifecycle.stop()
            Lifecycle.Event.ON_DESTROY -> nativeLifecycle.destroy()
            else -> Unit
        }
    }
    lifecycle.addObserver(observer)
    return onDispose {
        lifecycle.removeObserver(observer)
        nativeLifecycle.destroy()
    }
}

@Composable
internal fun LocationPicker(value: LatLng?, modifier: Modifier = Modifier, onChange: (LatLng) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val onChangeState by rememberUpdatedState(onChange)
    var readyMap by remember { mutableStateOf<GoogleMap?>(null) }
    val mapView = rememberMapView()
    DisposableEffect(mapView, lifecycleOwner) { bindMapLifecycle(mapView, lifecycleOwner.lifecycle) }
    Box(modifier.fillMaxWidth().height(240.dp).clip(MaterialTheme.shapes.large)) {
        AndroidView(factory = { mapView }, modifier = Modifier.fillMaxSize(), update = { view ->
            view.getMapAsync { map ->
                if (view.tag == DESTROYED_TAG) return@getMapAsync
                if (readyMap !== map) {
                    readyMap = map
                    map.uiSettings.isZoomControlsEnabled = false
                    map.uiSettings.isMyLocationButtonEnabled = false
                    map.uiSettings.isMapToolbarEnabled = false
                    runCatching { map.setMapStyle(MapStyleOptions.loadRawResourceStyle(context, R.raw.map_style)) }
                    map.setOnMapClickListener { coordinate -> onChangeState(coordinate) }
                }
                map.clear()
                value?.let { coordinate ->
                    map.addMarker(MarkerOptions().position(coordinate).title("写真"))
                    map.moveCamera(CameraUpdateFactory.newLatLngZoom(coordinate, 16f))
                }
            }
        })
        Text(
            "地図をタップして位置を選択",
            modifier = Modifier.align(Alignment.TopCenter).padding(top = 12.dp)
                .background(AppColors.surface.copy(alpha = 0.94f), CircleShape)
                .padding(horizontal = 12.dp, vertical = 6.dp),
            style = MaterialTheme.typography.labelMedium,
            color = AppColors.ink,
        )
    }
}

internal fun hasLocationPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, android.Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED

/** How far the location permission goes. Recording works from [APPROXIMATE] up, and each step below [ALWAYS] loses something. */
internal enum class LocationAccess { NONE, APPROXIMATE, WHILE_IN_USE, ALWAYS }

internal fun currentLocationAccess(context: Context): LocationAccess {
    fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == android.content.pm.PackageManager.PERMISSION_GRANTED
    return when {
        !hasLocationPermission(context) -> LocationAccess.NONE
        !granted(android.Manifest.permission.ACCESS_FINE_LOCATION) -> LocationAccess.APPROXIMATE
        // Before Android 10 the location permission covers the background as well.
        android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q && !granted(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION) -> LocationAccess.WHILE_IN_USE
        else -> LocationAccess.ALWAYS
    }
}

@SuppressLint("MissingPermission")
internal fun enableMyLocation(map: GoogleMap, context: Context) {
    if (hasLocationPermission(context)) runCatching { map.isMyLocationEnabled = true }
}

/** Centers on the device's last known location, or on a city-level default without one. */
@SuppressLint("MissingPermission")
internal fun moveToCurrentLocation(context: Context, map: GoogleMap, animate: Boolean = false) {
    fun move(target: LatLng, zoom: Float) {
        val update = CameraUpdateFactory.newLatLngZoom(target, zoom)
        if (animate) map.animateCamera(update) else map.moveCamera(update)
    }
    if (!hasLocationPermission(context)) return move(DEFAULT_CENTER, 11f)
    LocationServices.getFusedLocationProviderClient(context).lastLocation
        .addOnSuccessListener { location -> if (location != null) move(LatLng(location.latitude, location.longitude), 16f) else move(DEFAULT_CENTER, 11f) }
        .addOnFailureListener { move(DEFAULT_CENTER, 11f) }
}

/** Fits every point into the padded viewport; Google Maps picks the tightest zoom. */
internal fun fitMap(map: GoogleMap, points: List<LatLng>, density: Float, animate: Boolean = false) {
    val update = when {
        points.isEmpty() -> CameraUpdateFactory.newLatLngZoom(DEFAULT_CENTER, 11f)
        points.size == 1 -> CameraUpdateFactory.newLatLngZoom(points.first(), 17f)
        else -> {
            val bounds = LatLngBounds.Builder().apply { points.forEach(::include) }.build()
            val span = maxOf(bounds.northeast.latitude - bounds.southwest.latitude, bounds.northeast.longitude - bounds.southwest.longitude)
            if (span < 0.0005) CameraUpdateFactory.newLatLngZoom(bounds.center, 18f)
            else CameraUpdateFactory.newLatLngBounds(bounds, (48 * density).toInt())
        }
    }
    runCatching { if (animate) map.animateCamera(update) else map.moveCamera(update) }
        .onFailure { points.firstOrNull()?.let { map.moveCamera(CameraUpdateFactory.newLatLngZoom(it, 16f)) } }
}

private data class MapRenderKey(
    val viewKey: String,
    val loaded: Boolean,
    val routeSegments: List<RouteSegment>,
    val routeRgb: Int,
    val stayClusters: List<StayCluster>,
    val stayLabels: Map<String, StayPlaceLabel>,
    val photoClusters: List<PhotoCluster>,
    val photoThumbnails: Map<String, Bitmap?>,
    val focusTarget: TimelineMapFocus?,
    val replaying: Boolean,
)

private class RenderedRoute(var path: RouteRenderPath, var rgb: Int, val line: Polyline, var chevrons: Polyline? = null) {
    fun remove() {
        line.remove()
        chevrons?.remove()
    }
}

private fun routeSpans(path: RouteRenderPath, rgb: Int): List<StyleSpan> = gradientRuns(path.alphas).map { (segments, start, end) ->
    StyleSpan(StrokeStyle.gradientBuilder(MapColors.argb((start * 255).toInt(), rgb), MapColors.argb((end * 255).toInt(), rgb)).build(), segments.toDouble())
}

private enum class StayCircleState { NORMAL, SELECTED, DIMMED }

private fun Circle.applyStayStyle(stay: StayCluster, state: StayCircleState, px: Float) {
    val selected = state == StayCircleState.SELECTED
    radius = stayCircleRadiusMeters(stay.durationMs) + if (selected) 8.0 else 0.0
    strokeColor = MapColors.argb(when (state) { StayCircleState.NORMAL -> 170; StayCircleState.SELECTED -> 255; StayCircleState.DIMMED -> 50 }, MapColors.stayRgb)
    strokeWidth = (if (selected) 2.5f else 1.5f) * px
    fillColor = MapColors.argb(when (state) { StayCircleState.NORMAL -> 46; StayCircleState.SELECTED -> 90; StayCircleState.DIMMED -> 14 }, MapColors.stayRgb)
    zIndex = if (selected) 1f else 0f
}

/** The chevron line is wider than the route so its marks overhang the line slightly. */
private const val CHEVRON_WIDTH_DP = 8f
/** Distance between chevrons along the line. */
private const val CHEVRON_SPACING_DP = 72f

/** A transparent stroke that only carries the repeating chevron texture. */
private fun chevronSpans(stamp: BitmapDescriptor) =
    listOf(StyleSpan(StrokeStyle.colorBuilder(android.graphics.Color.TRANSPARENT).stamp(TextureStyle.newBuilder(stamp).build()).build()))

/**
 * One tile of the texture repeated along a line: a small open chevron in the
 * middle of a long transparent strip. The texture's width is scaled to the
 * line's width, so the strip's length sets the spacing.
 */
private fun chevronStamp(rgb: Int, px: Float): BitmapDescriptor {
    val width = (CHEVRON_WIDTH_DP * px).toInt()
    val height = (CHEVRON_SPACING_DP * px).toInt()
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val center = width / 2f
    val middle = height / 2f
    val half = width * 0.32f
    val depth = width * 0.2f
    // Maps lays the strip's bottom edge toward the end of the line, so the chevron points down.
    Canvas(bitmap).drawPath(Path().apply {
        moveTo(center - half, middle - depth)
        lineTo(center, middle + depth)
        lineTo(center + half, middle - depth)
    }, Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.6f * px
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = MapColors.argb(230, rgb)
    })
    return BitmapDescriptorFactory.fromBitmap(bitmap)
}

/** The replay's current position: a filled dot in a white ring. */
private fun replayHeadIcon(px: Float): BitmapDescriptor {
    val size = (22 * px).toInt()
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val center = size / 2f
    canvas.drawCircle(center, center, 8 * px, Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.WHITE
        setShadowLayer(2 * px, 0f, 1 * px, android.graphics.Color.argb(70, 0, 0, 0))
    })
    canvas.drawCircle(center, center, 5.5f * px, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = MapColors.argb(255, MapColors.focusRouteRgb) })
    return BitmapDescriptorFactory.fromBitmap(bitmap)
}

/** Play/pause, the replayed moment's time, a scrubber, and a way out. */
@Composable
private fun ReplayBar(
    time: Long,
    progress: Float,
    playing: Boolean,
    modifier: Modifier = Modifier,
    onTogglePlaying: () -> Unit,
    onSeek: (Float) -> Unit,
    onClose: () -> Unit,
) {
    Surface(modifier.fillMaxWidth(), shape = CircleShape, color = AppColors.surface, shadowElevation = 3.dp) {
        Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onTogglePlaying) {
                Icon(if (playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, if (playing) "一時停止" else "再生", tint = AppColors.ink, modifier = Modifier.size(24.dp))
            }
            Text(formatTime(time), style = MaterialTheme.typography.labelLarge, color = AppColors.ink)
            Slider(value = progress, onValueChange = onSeek, modifier = Modifier.weight(1f).padding(horizontal = 12.dp))
            IconButton(onClick = onClose) {
                Icon(Icons.Outlined.Close, "リプレイを閉じる", tint = AppColors.ink, modifier = Modifier.size(24.dp))
            }
        }
    }
}

/** 48dp round photo marker: white ring, soft shadow, thumbnail or a camera glyph, and a count badge. */
private fun photoMarkerIcon(context: Context, thumbnail: Bitmap?, photoCount: Int, isVideo: Boolean = false) = BitmapDescriptorFactory.fromBitmap(run {
    val density = context.resources.displayMetrics.density
    val size = (48 * density).toInt()
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val center = size / 2f
    val radius = 17 * density
    val ring = 2.5f * density
    canvas.drawCircle(center, center + 0.5f * density, radius + ring, Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.WHITE
        setShadowLayer(3 * density, 0f, 1 * density, android.graphics.Color.argb(70, 0, 0, 0))
    })
    if (thumbnail != null) {
        val cropSize = minOf(thumbnail.width, thumbnail.height)
        val left = (thumbnail.width - cropSize) / 2
        val top = (thumbnail.height - cropSize) / 2
        canvas.save()
        canvas.clipPath(Path().apply { addCircle(center, center, radius, Path.Direction.CW) })
        canvas.drawBitmap(thumbnail, Rect(left, top, left + cropSize, top + cropSize), RectF(center - radius, center - radius, center + radius, center + radius), Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
        canvas.restore()
    } else {
        canvas.drawCircle(center, center, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.rgb(158, 106, 44) })
        ContextCompat.getDrawable(context, if (isVideo) R.drawable.ic_marker_video else R.drawable.ic_marker_photo)?.let { glyph ->
            val half = (9 * density).toInt()
            glyph.setBounds((center - half).toInt(), (center - half).toInt(), (center + half).toInt(), (center + half).toInt())
            glyph.draw(canvas)
        }
    }
    if (photoCount > 1) {
        val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.WHITE; textSize = 10 * density; textAlign = Paint.Align.CENTER; typeface = Typeface.DEFAULT_BOLD }
        val text = if (photoCount > 99) "99+" else photoCount.toString()
        val badgeHeight = 17 * density
        val badgeWidth = maxOf(badgeHeight, label.measureText(text) + 10 * density)
        val right = size - 1 * density
        val top = 1 * density
        val badge = RectF(right - badgeWidth, top, right, top + badgeHeight)
        canvas.drawRoundRect(badge, badgeHeight / 2, badgeHeight / 2, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.WHITE })
        badge.inset(1.5f * density, 1.5f * density)
        canvas.drawRoundRect(badge, badge.height() / 2, badge.height() / 2, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.rgb(47, 90, 69) })
        canvas.drawText(text, badge.centerX(), badge.centerY() - (label.ascent() + label.descent()) / 2, label)
    }
    bitmap
})

private fun routeWidth(path: RouteRenderPath): Float = if (path.untracked) 3f else 4f

/** Dotted where nothing was recorded, so a straight connection is not read as the route taken. */
private fun routePattern(path: RouteRenderPath, px: Float): List<PatternItem>? =
    if (path.untracked) listOf(Dot(), Gap(6 * px)) else null
