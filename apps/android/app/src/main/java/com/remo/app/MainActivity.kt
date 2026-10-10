package com.remo.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.produceState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.BottomSheetScaffold
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberBottomSheetScaffoldState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val transparent = android.graphics.Color.TRANSPARENT
        // Bar icons follow the system appearance, like the rest of the app.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(transparent, transparent),
            navigationBarStyle = SystemBarStyle.auto(transparent, transparent),
        )
        super.onCreate(savedInstanceState)
        setContent { RemoTheme { RemoRoot() } }
    }
}

@Composable
private fun RemoRoot(viewModel: AuthViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var showAuth by remember { mutableStateOf(false) }
    LaunchedEffect(state.signedIn) {
        if (state.signedIn) showAuth = false
    }
    Surface(Modifier.fillMaxSize(), color = AppColors.background) {
        if (!state.initialized) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(32.dp), color = AppColors.green, strokeWidth = 3.dp)
            }
            return@Surface
        }
        // Auth sits on top so closing it returns to the same screen and day.
        TrackerHome(state.user, viewModel::signOut, viewModel::deleteAccount, viewModel::sessionExpired) { showAuth = true }
        if (showAuth && !state.signedIn) AuthScreen(state, viewModel) { showAuth = false }
    }
}

@Composable
internal fun TrackerHome(user: RemoUser?, onSignOut: () -> Unit, onDeleteAccount: suspend (String) -> String?, onSessionExpired: () -> Unit = {}, onOpenAuth: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val store = remember { LogStore.get(context) }
    val snackbar = remember { SnackbarHostState() }
    var showSettings by remember { mutableStateOf(false) }
    var selectedDate by remember { mutableStateOf(dayKey(System.currentTimeMillis())) }
    var selectedLog by remember { mutableStateOf<LogEntry?>(null) }
    var selectedPhotos by remember { mutableStateOf<List<LogEntry>?>(null) }
    var mapFocusTarget by remember { mutableStateOf<TimelineMapFocus?>(null) }
    var historyTarget by remember { mutableStateOf<PlaceHistoryTarget?>(null) }
    var homeMode by remember { mutableStateOf(HomeMode.DAY) }
    var placePeriod by remember { mutableStateOf(PlacePeriod.ALL) }
    var selectedPlaceId by remember { mutableStateOf<String?>(null) }
    val savedAllPlacesCamera = remember { SavedCamera() }
    var autoCapture by remember { mutableStateOf(AutomaticCaptureService.isEnabled(context)) }
    var photoAccess by remember { mutableStateOf(PhotoLibrary.hasAnyAccess(context)) }
    var photoLocationAccess by remember { mutableStateOf(PhotoLibrary.hasMediaLocationAccess(context)) }
    var libraryPhotos by remember { mutableStateOf<List<LibraryPhoto>>(emptyList()) }
    var syncStatus by remember { mutableStateOf(if (user == null) "端末に保存済み" else "バックアップ待ち") }
    var lastBackupAt by remember { mutableStateOf<Long?>(BackupCoordinator.lastSuccessAt(context)) }
    var status by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var showAccountDeletion by remember { mutableStateOf(false) }
    var showExportDialog by remember { mutableStateOf(false) }
    var exportStartDate by remember { mutableStateOf(selectedDate) }
    var exportEndDate by remember { mutableStateOf(selectedDate) }
    var pendingExport by remember { mutableStateOf<Pair<String, String>?>(null) }
    // The records on this device are backed up to another account than the one signed in.
    var ownershipConflict by remember { mutableStateOf(false) }
    val introPreferences = remember { context.getSharedPreferences("rem_intro", Context.MODE_PRIVATE) }
    var showLocationIntro by remember { mutableStateOf(false) }
    var syncInFlight by remember { mutableStateOf(false) }
    var syncQueued by remember { mutableStateOf(false) }
    var photoRevision by remember { mutableIntStateOf(0) }
    var photoIndexing by remember { mutableStateOf(false) }
    var photoRefreshJob by remember { mutableStateOf<Job?>(null) }

    val exportLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val range = pendingExport
        pendingExport = null
        if (uri != null && range != null) {
            scope.launch {
                status = "JSONを書き出し中…"
                // Written a day at a time, so a year of records is never held in memory.
                runCatching {
                    withContext(Dispatchers.IO) {
                        context.contentResolver.openOutputStream(uri)?.use { output -> writeTimelineExport(output, store, range.first, range.second) { writer, fromMs, toMs -> CaptureDiagnostics.writeExport(context, writer, fromMs, toMs) } }
                            ?: error("ファイルを開けませんでした")
                    }
                }.onSuccess { status = "JSONを書き出しました" }
                    .onFailure { if (it is CancellationException) throw it; status = "エクスポートに失敗しました" }
            }
        }
    }

    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (hasLocationPermission(context)) {
            AutomaticCaptureService.setEnabled(context, true)
            autoCapture = true
            status = "位置情報の記録を開始しました"
        } else {
            autoCapture = false
            status = "位置情報の記録には許可が必要です"
        }
    }
    val photoPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        refreshPhotoState(context, scope) { access, locationAccess, photos ->
            photoAccess = access
            photoLocationAccess = locationAccess
            libraryPhotos = photos
            photoRevision += 1
        }
    }

    fun requestLocation() {
        val permissions = requiredLocationPermissions(context)
        if (autoCapture && hasLocationPermission(context)) {
            AutomaticCaptureService.setEnabled(context, false)
            autoCapture = false
            status = "位置情報の記録を停止しました"
        } else if (permissions.isEmpty()) {
            AutomaticCaptureService.setEnabled(context, true)
            autoCapture = true
            status = "位置情報の記録を開始しました"
        } else {
            locationPermission.launch(permissions)
        }
    }

    fun requestPhotos() {
        val missing = PhotoLibrary.missingPermissions(context)
        if (missing.isNotEmpty()) {
            photoPermission.launch(missing)
        } else {
            openPhotoSettings(context)
        }
    }

    fun refreshPhotos() {
        refreshPhotoState(context, scope) { access, locationAccess, photos ->
            photoAccess = access
            photoLocationAccess = locationAccess
            libraryPhotos = photos
            photoRevision += 1
        }
    }

    suspend fun sync(force: Boolean = false) {
        if (syncInFlight) {
            syncQueued = true
            return
        }
        syncInFlight = true
        syncStatus = "バックアップ中…"
        try {
            syncStatus = BackupCoordinator.synchronize(context, force)
            ownershipConflict = syncStatus == BackupCoordinator.STATUS_OTHER_ACCOUNT
            lastBackupAt = BackupCoordinator.lastSuccessAt(context)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: SessionExpiredException) {
            // The session ended (expired, or signed out everywhere): say so
            // instead of looking offline, and offer to sign in again.
            syncStatus = "再ログインが必要です"
            status = "ログインの有効期限が切れました。設定からもう一度ログインしてください"
            onSessionExpired()
        } catch (_: Exception) {
            syncStatus = "オフライン · 端末に保存済み"
        } finally {
            syncInFlight = false
            if (syncQueued) {
                syncQueued = false
                scope.launch { sync() }
            }
        }
    }

    val importLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            status = "JSONを読み込み中…"
            runCatching {
                val payload = withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(uri)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
                        ?: error("ファイルを開けませんでした")
                }
                val imported = withContext(Dispatchers.Default) { decodeTimelineImport(payload) }
                store.importAll(imported)
                imported.maxByOrNull(LogEntry::startedAt)?.let { selectedDate = dayKey(it.startedAt) }
                sync()
                imported.size
            }.onSuccess { count -> status = "${count}件の記録を読み込みました" }
                .onFailure { error -> status = error.message ?: "インポートに失敗しました" }
        }
    }

    suspend fun indexPhotos(syncAfter: Boolean = true) {
        if (!photoAccess || photoIndexing) return
        photoIndexing = true
        val generation = store.generation
        try {
            val selectedDay = parseDate(selectedDate)
            val hadSelectedDay = store.hasEntriesBetween(selectedDay.timeInMillis, (selectedDay.clone() as Calendar).apply { add(Calendar.DAY_OF_MONTH, 1) }.timeInMillis)
            val photoRecords = store.photoEntries()
            val result = PhotoLibrary.indexAll(context, photoRecords.mapTo(HashSet()) { it.id })
            store.upsertAll(inheritPhotoCorrections(result.entries, result.inheritedCorrections, photoRecords), generation)
            val present = store.photoEntries().mapTo(HashSet()) { it.id }
            store.deleteAll(result.staleEventIds.filter { it in present }, generation)
            if (result.entries.isNotEmpty() && !hadSelectedDay) {
                result.entries.maxByOrNull(LogEntry::startedAt)?.let { selectedDate = dayKey(it.startedAt) }
            }
            if (syncAfter && result.entries.isNotEmpty()) sync()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            status = "写真を読み込めませんでした。次に開いたときに再試行します"
        } finally {
            photoIndexing = false
        }
    }

    DisposableEffect(context, lifecycleOwner) {
        val lifecycleObserver = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                refreshPhotos()
                scope.launch { store.reload(); sync() }
            }
        }
        lifecycleOwner.lifecycle.addObserver(lifecycleObserver)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(lifecycleObserver)
        }
    }

    DisposableEffect(context) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                photoRefreshJob?.cancel()
                photoRefreshJob = scope.launch { delay(750); refreshPhotos() }
            }
        }
        context.contentResolver.registerContentObserver(MediaStore.Files.getContentUri("external"), true, observer)
        onDispose { photoRefreshJob?.cancel(); context.contentResolver.unregisterContentObserver(observer) }
    }

    LaunchedEffect(user?.id) {
        syncStatus = if (user == null) "端末に保存済み" else "バックアップ待ち"
        lastBackupAt = BackupCoordinator.lastSuccessAt(context)
        store.reload()
        BackupWorker.schedule(context)
        if (autoCapture && !hasLocationPermission(context)) {
            // Explain what is recorded before the system asks; the prompt alone has no context.
            if (introPreferences.getBoolean("location_intro_shown", false)) locationPermission.launch(requiredLocationPermissions(context))
            else showLocationIntro = true
        } else if (autoCapture) {
            AutomaticCaptureService.setEnabled(context, true)
        }
        refreshPhotos()
        sync()
    }
    LaunchedEffect(photoRevision, photoAccess) { indexPhotos() }
    LaunchedEffect(Unit) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                delay(60_000)
                sync()
            }
        }
    }
    LaunchedEffect(status) {
        val message = status ?: return@LaunchedEffect
        snackbar.showSnackbar(message)
        status = null
    }
    BackHandler(enabled = showSettings) { showSettings = false }

    // Keep derived lists stable across unrelated sheet/dialog recompositions.
    // This prevents the embedded map from treating every recomposition as a
    // new data set and rebuilding all of its overlays.
    val dayRange = remember(selectedDate) {
        val start = parseDate(selectedDate)
        val end = (start.clone() as Calendar).apply { add(Calendar.DAY_OF_MONTH, 1) }
        start.timeInMillis until end.timeInMillis
    }
    // null while the selected day is still being prepared.
    var timeline by remember(selectedDate) { mutableStateOf<TimelineRenderSnapshot?>(null) }
    LaunchedEffect(dayRange, lifecycleOwner, showSettings) {
        if (showSettings) return@LaunchedEffect
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            // Only the selected day is read into memory; it is read again whenever the stored records change.
            snapshotFlow { store.revision }.collectLatest {
                val visible = store.entriesBetween(dayRange.first, dayRange.last + 1)
                timeline = withContext(Dispatchers.Default) { prepareTimeline(visible) }
            }
        }
    }
    val stayIndex = rememberStayIndex(context, store)
    LaunchedEffect(store.revision) { NamedPlaces.places = store.places() }
    // Location samples around the photo being corrected: the suggestion reads the track near it.
    val nearbyLogs by produceState(emptyList<LogEntry>(), selectedLog?.id, selectedLog?.startedAt, store.revision) {
        val entry = selectedLog
        value = if (entry == null) emptyList() else store.entriesBetween(entry.startedAt - NEARBY_WINDOW_MS, entry.startedAt + NEARBY_WINDOW_MS)
    }
    val persistenceFailed = RemoApplication.persistenceFailed
    LaunchedEffect(persistenceFailed) {
        if (persistenceFailed) {
            status = "記録を保存できませんでした。端末の空き容量を確認してください"
            RemoApplication.persistenceFailed = false
        }
    }
    val periodStays = remember(stayIndex.stays, placePeriod) { stayIndex.stays?.let { staysInPeriod(it, placePeriod) } }
    val allPlaces by produceState<List<AllTimeStayPlace>?>(null, periodStays) {
        value = periodStays?.let { stays -> withContext(Dispatchers.Default) { buildAllTimeStayPlaces(stays) } }
    }
    fun updateLog(updated: LogEntry) {
        selectedLog = updated
        scope.launch { store.upsert(updated); sync() }
    }
    fun openExportDialog() {
        exportStartDate = selectedDate
        exportEndDate = selectedDate
        showExportDialog = true
    }
    fun exportSelectedRange() {
        val from = minOf(exportStartDate, exportEndDate)
        val to = maxOf(exportStartDate, exportEndDate)
        pendingExport = from to to
        showExportDialog = false
        exportLauncher.launch("remo-timeline-$from-$to.json")
    }

    Box(Modifier.fillMaxSize()) {
        if (showSettings) {
            SettingsScreen(
                SettingsState(autoCapture, photoAccess, photoLocationAccess, syncStatus, lastBackupAt, user),
                SettingsActions(
                    onBack = { showSettings = false },
                    onCapture = ::requestLocation,
                    onPhotos = ::requestPhotos,
                    onExport = ::openExportDialog,
                    onImport = { importLauncher.launch(arrayOf("application/json", "text/plain")) },
                    onDeleteAll = { confirmDelete = true },
                    onBackup = { scope.launch { sync(force = true) } },
                    onOpenAuth = onOpenAuth,
                    onSignOut = onSignOut,
                    onDeleteAccount = { showAccountDeletion = true },
                ),
            )
        } else {
            TimelineHome(
                mode = homeMode,
                allPlaces = allPlaces,
                periodStays = periodStays,
                stayIndexProgress = stayIndex.progress,
                placePeriod = placePeriod,
                selectedPlaceId = selectedPlaceId,
                savedAllPlacesCamera = savedAllPlacesCamera,
                onModeChange = { homeMode = it },
                onPlacePeriodChange = { placePeriod = it },
                onSelectPlace = { place, label ->
                    selectedPlaceId = place.id
                    historyTarget = PlaceHistoryTarget(place.coordinate, label, place.visits)
                },
                selectedDate = selectedDate,
                timeline = timeline,
                libraryPhotos = libraryPhotos,
                autoCapture = autoCapture,
                focus = mapFocusTarget,
                onDateChange = { selectedDate = it; mapFocusTarget = null },
                onFocus = { activity -> mapFocusTarget = if (mapFocusTarget?.activityId == activity.id) null else timelineMapFocus(activity) },
                onSelectPhotos = { selectedPhotos = it },
                onOpenHistory = { historyTarget = it },
                onOpenSettings = { showSettings = true },
            )
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(16.dp)) { data ->
            Snackbar(data, shape = MaterialTheme.shapes.medium, containerColor = AppColors.ink, contentColor = AppColors.onNight)
        }
    }

    historyTarget?.let { target ->
        // Read from the stay index once it is ready, so the history matches the all-places map.
        val history by produceState<StayVisitHistory?>(null, target, stayIndex.stays) {
            // Until the index is ready the sheet shows that it is being prepared.
            value = target.visits?.let(::historyOf)
                ?: stayIndex.stays?.let { stayVisitHistoryFromStays(it, target.coordinate) }
        }
        PlaceHistorySheet(
            history, target,
            onDismiss = { historyTarget = null },
            onRename = { current, name ->
                scope.launch {
                    store.putPlace(NamedPlace(
                        id = current?.id ?: java.util.UUID.randomUUID().toString(),
                        name = name,
                        latitude = current?.latitude ?: target.coordinate.latitude,
                        longitude = current?.longitude ?: target.coordinate.longitude,
                        deleted = name.isEmpty(),
                    ))
                    sync(force = true)
                }
            },
        ) { day ->
            historyTarget = null
            selectedDate = day
            homeMode = HomeMode.DAY
            mapFocusTarget = null
        }
    }
    selectedPhotos?.let { photos ->
        PhotoListSheet(photos, libraryPhotos, { selectedPhotos = null }) { photo -> selectedPhotos = null; selectedLog = photo }
    }
    selectedLog?.let { entry ->
        DetailDialog(entry, nearbyLogs, { selectedLog = null }, ::updateLog) {
            selectedLog = null
            scope.launch { store.delete(entry); sync() }
            status = "記録を削除しました"
        }
    }
    if (showAccountDeletion) {
        AccountDeletionDialog(
            onDismiss = { showAccountDeletion = false },
            onDelete = { password ->
                onDeleteAccount(password).also { error ->
                    if (error == null) {
                        showAccountDeletion = false
                        lastBackupAt = null
                        syncStatus = "端末に保存済み"
                        status = "アカウントとクラウドのバックアップを削除しました"
                    }
                }
            },
        )
    }
    if (confirmDelete) {
        ConfirmDeleteDialog(
            title = "すべての記録を削除しますか？",
            message = if (user != null && !ownershipConflict) "この端末とクラウドのバックアップから、位置と写真の記録をすべて削除し、位置情報の記録を停止します。他の端末に保存されている記録は、その端末に残ります。この操作は元に戻せません。"
                else "この端末から、位置と写真の記録をすべて削除し、位置情報の記録を停止します。この操作は元に戻せません。",
            onDismiss = { confirmDelete = false },
            onConfirm = {
                scope.launch {
                    runCatching { BackupCoordinator.deleteAll(context) }
                        .onSuccess { autoCapture = false; status = "すべての記録を削除し、位置情報の記録を停止しました" }
                        .onFailure { status = "クラウドに接続できないため削除できませんでした" }
                }
            },
            confirmLabel = "すべて削除",
        )
    }
    if (ownershipConflict && user != null) {
        OwnershipDialog(
            email = user.email,
            onMerge = { ownershipConflict = false; scope.launch { BackupCoordinator.adoptRecords(context); sync(force = true) } },
            onReplace = {
                ownershipConflict = false
                scope.launch {
                    BackupCoordinator.replaceRecords(context)
                    refreshPhotos()
                    sync(force = true)
                }
            },
            onSignOut = { ownershipConflict = false; onSignOut() },
        )
    }
    if (showLocationIntro) {
        LocationIntroDialog(
            onStart = {
                showLocationIntro = false
                introPreferences.edit().putBoolean("location_intro_shown", true).apply()
                locationPermission.launch(requiredLocationPermissions(context))
            },
            onLater = {
                showLocationIntro = false
                introPreferences.edit().putBoolean("location_intro_shown", true).apply()
                AutomaticCaptureService.setEnabled(context, false)
                autoCapture = false
            },
        )
    }
    if (showExportDialog) {
        val from = minOf(exportStartDate, exportEndDate)
        val to = maxOf(exportStartDate, exportEndDate)
        // Counted by the database; the records themselves are not loaded.
        val summary by produceState<RangeSummary?>(null, from, to, store.revision) {
            value = store.summarize(parseDate(from).timeInMillis, parseDate(to).apply { add(Calendar.DAY_OF_MONTH, 1) }.timeInMillis)
        }
        ExportRangeDialog(
            startDate = exportStartDate,
            endDate = exportEndDate,
            locationCount = summary?.locationCount,
            photoCount = summary?.photoCount,
            onStartDateChange = { exportStartDate = it },
            onEndDateChange = { exportEndDate = it },
            onDismiss = { showExportDialog = false },
            onExport = ::exportSelectedRange,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimelineHome(
    mode: HomeMode,
    allPlaces: List<AllTimeStayPlace>?,
    periodStays: List<StaySummary>?,
    stayIndexProgress: StayIndexProgress?,
    placePeriod: PlacePeriod,
    selectedPlaceId: String?,
    savedAllPlacesCamera: SavedCamera,
    onModeChange: (HomeMode) -> Unit,
    onPlacePeriodChange: (PlacePeriod) -> Unit,
    onSelectPlace: (AllTimeStayPlace, StayPlaceLabel?) -> Unit,
    selectedDate: String,
    timeline: TimelineRenderSnapshot?,
    libraryPhotos: List<LibraryPhoto>,
    autoCapture: Boolean,
    focus: TimelineMapFocus?,
    onDateChange: (String) -> Unit,
    onFocus: (TimelineActivity) -> Unit,
    onSelectPhotos: (List<LogEntry>) -> Unit,
    onOpenHistory: (PlaceHistoryTarget) -> Unit,
    onOpenSettings: () -> Unit,
) {
    val density = LocalDensity.current
    val scaffoldState = rememberBottomSheetScaffoldState()
    val sheetState = scaffoldState.bottomSheetState
    val listState = rememberLazyListState()
    val placesListState = rememberLazyListState()
    val sheetScope = rememberCoroutineScope()
    val navigationBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val peekHeight = SheetPeekContentHeight + navigationBottom
    var sheetContentHeight by remember { mutableStateOf(0.dp) }
    // A collapsed sheet should always show the day header, not a mid-list row.
    LaunchedEffect(sheetState.currentValue) {
        if (sheetState.currentValue == SheetValue.PartiallyExpanded) {
            listState.animateScrollToItem(0)
            placesListState.animateScrollToItem(0)
        }
    }
    LaunchedEffect(selectedDate) { listState.scrollToItem(0) }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        // Cap the open sheet so the focused stay or route stays visible above it.
        val sheetMaxHeight = maxHeight * 0.62f
        val expanded = sheetState.targetValue == SheetValue.Expanded
        BottomSheetScaffold(
            scaffoldState = scaffoldState,
            sheetPeekHeight = peekHeight,
            sheetShape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
            sheetContainerColor = AppColors.surface,
            sheetShadowElevation = 8.dp,
            sheetDragHandle = { SheetHandle() },
            containerColor = AppColors.background,
            sheetContent = {
                val sheetModifier = Modifier.heightIn(max = sheetMaxHeight).onSizeChanged { sheetContentHeight = with(density) { it.height.toDp() } }
                if (mode == HomeMode.ALL) {
                    AllPlacesSheetContent(
                        places = allPlaces,
                        stays = periodStays,
                        progress = stayIndexProgress,
                        period = placePeriod,
                        selectedPlaceId = selectedPlaceId,
                        listState = placesListState,
                        bottomPadding = navigationBottom + 24.dp,
                        modifier = sheetModifier,
                        onPeriodChange = onPlacePeriodChange,
                        onSelectPlace = { place, label ->
                            // Lower the sheet so the selected place is visible above it.
                            sheetScope.launch { sheetState.partialExpand() }
                            onSelectPlace(place, label)
                        },
                    )
                } else {
                    TimelineSheetContent(
                        selectedDate = selectedDate,
                        timeline = timeline ?: TimelineRenderSnapshot(),
                        loaded = timeline != null,
                        photos = libraryPhotos,
                        autoCapture = autoCapture,
                        selectedActivityId = focus?.activityId,
                        listState = listState,
                        bottomPadding = navigationBottom + 24.dp,
                        modifier = sheetModifier,
                        onDateChange = onDateChange,
                        onFocus = onFocus,
                        onSelectPhotos = onSelectPhotos,
                        onOpenHistory = onOpenHistory,
                    )
                }
            },
        ) {
            val mapPadding = PaddingValues(top = statusTop + MapTopInset, bottom = if (expanded) sheetContentHeight + 20.dp else peekHeight)
            val controls: @Composable BoxScope.() -> Unit = {
                Column(
                    Modifier.align(Alignment.TopStart).statusBarsPadding().padding(start = 12.dp, top = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        MapControlButton(Icons.Outlined.Settings, "設定", onClick = onOpenSettings)
                        RecordingPill(autoCapture, onOpenSettings)
                    }
                    ModeToggle(mode, onModeChange)
                }
            }
            if (mode == HomeMode.ALL) {
                AllPlacesMap(
                    places = allPlaces,
                    selectedPlaceId = selectedPlaceId,
                    savedCamera = savedAllPlacesCamera,
                    contentPadding = mapPadding,
                    modifier = Modifier.fillMaxSize(),
                    onSelectPlace = { onSelectPlace(it, null) },
                    overlay = controls,
                )
            } else {
                TimelineMap(
                    timeline = timeline ?: TimelineRenderSnapshot(),
                    loaded = timeline != null,
                    viewKey = selectedDate,
                    photos = libraryPhotos,
                    contentPadding = mapPadding,
                    focusTarget = focus,
                    modifier = Modifier.fillMaxSize(),
                    onSelectPhotos = onSelectPhotos,
                    overlay = controls,
                )
            }
        }
    }
}

/** Height of the controls stacked over the top of the map. */
private val MapTopInset = 112.dp

@Composable
private fun RecordingPill(recording: Boolean, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = CircleShape, color = AppColors.surface, shadowElevation = 3.dp) {
        Row(Modifier.padding(start = 12.dp, end = 14.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(8.dp).background(if (recording) AppColors.mint else AppColors.outlineStrong, CircleShape))
            Text(if (recording) "記録中" else "記録を停止中", style = MaterialTheme.typography.labelLarge, color = AppColors.ink)
        }
    }
}

private const val NEARBY_WINDOW_MS = 60 * 60_000L

private fun requiredLocationPermissions(context: Context): Array<String> = buildList {
    add(Manifest.permission.ACCESS_FINE_LOCATION)
    add(Manifest.permission.ACCESS_COARSE_LOCATION)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) add(Manifest.permission.ACTIVITY_RECOGNITION)
    // The recording notification is how the user sees (and stops) background recording.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
}.filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }.toTypedArray()

private fun openPhotoSettings(context: Context) {
    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply { data = Uri.parse("package:${context.packageName}") })
}

private fun refreshPhotoState(context: Context, scope: kotlinx.coroutines.CoroutineScope, onLoaded: (Boolean, Boolean, List<LibraryPhoto>) -> Unit) {
    val access = PhotoLibrary.hasAnyAccess(context)
    val locationAccess = PhotoLibrary.hasMediaLocationAccess(context)
    scope.launch {
        val photos = try { withContext(Dispatchers.IO) { PhotoLibrary.queryAll(context).also { LibraryPhotoLookup.forPhotos(it) } } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { return@launch }
        onLoaded(access, locationAccess, photos)
    }
}

/** Writes a Remo JSON document for the local days [from]..[to], reading one day at a time. */
internal suspend fun writeTimelineExport(
    output: java.io.OutputStream,
    store: LogStore,
    from: String,
    to: String,
    writeCaptureLog: ((android.util.JsonWriter, fromMs: Long, toMs: Long) -> Unit)? = null,
) {
    val writer = android.util.JsonWriter(output.bufferedWriter(Charsets.UTF_8))
    writer.setIndent("  ")
    var eventCount = 0
    var photoRecordCount = 0
    var photoCount = 0
    writer.beginObject()
    writer.name("schemaVersion").value(1)
    writer.name("exportedAt").value(isoTimestamp(System.currentTimeMillis()))
    writer.name("range").beginObject().name("from").value(from).name("to").value(to).endObject()
    writer.name("events").beginArray()
    var day = from
    while (day <= to) {
        for (entry in store.entriesOfDay(day)) {
            eventCount += 1
            if (entry.source == EventSource.PHOTO) { photoRecordCount += 1; photoCount += entry.photoCount }
            writer.beginObject()
            writer.name("id").value(entry.id)
            writer.name("startedAt").value(isoTimestamp(entry.startedAt))
            entry.latitude?.let { writer.name("latitude").value(it) }
            entry.longitude?.let { writer.name("longitude").value(it) }
            entry.originalLatitude?.let { writer.name("originalLatitude").value(it) }
            entry.originalLongitude?.let { writer.name("originalLongitude").value(it) }
            entry.locationSource?.let { writer.name("locationSource").value(it.wireValue) }
            writer.name("photoLocationAutoPlacementDisabled").value(entry.photoLocationAutoPlacementDisabled)
            entry.accuracyMeters?.let { writer.name("accuracyMeters").value(it) }
            entry.mediaType?.let { writer.name("mediaType").value(it.wireValue) }
            writer.name("photoCount").value(entry.photoCount.toLong())
            writer.name("source").value(entry.source.wireValue)
            writer.name("updatedAt").value(isoTimestamp(entry.updatedAt))
            writer.endObject()
        }
        day = shiftDay(day, 1)
    }
    writer.endArray()
    writer.name("summary").beginObject()
        .name("eventCount").value(eventCount.toLong())
        .name("photoRecordCount").value(photoRecordCount.toLong())
        .name("photoCount").value(photoCount.toLong())
        .endObject()
    if (writeCaptureLog != null) {
        // What the recording service decided and why; importers ignore it.
        writer.name("diagnostics").beginObject().name("captureLog")
        writeCaptureLog(writer, parseDate(from).timeInMillis, parseDate(shiftDay(to, 1)).timeInMillis - 1)
        writer.endObject()
    }
    writer.endObject()
    writer.flush()
}

/** The records on this device are backed up to another account than the one that signed in. */
@Composable
private fun OwnershipDialog(email: String, onMerge: () -> Unit, onReplace: () -> Unit, onSignOut: () -> Unit) {
    var confirmReplace by remember { mutableStateOf(false) }
    if (confirmReplace) {
        ConfirmDeleteDialog(
            title = "この端末の記録を削除しますか？",
            message = "別のアカウントで使っていた記録をこの端末から削除し、ログインしたアカウントの記録を表示します。元のアカウントのバックアップは残ります。",
            onDismiss = { confirmReplace = false },
            onConfirm = onReplace,
            confirmLabel = "削除して切り替える",
        )
        return
    }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onSignOut,
        title = { Text("別のアカウントの記録があります", style = MaterialTheme.typography.dialogTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("この端末には、別のアカウントでバックアップしていた記録が残っています。${email.ifBlank { "別のアカウント" }} にログインしました。", style = MaterialTheme.typography.bodyMedium, color = AppColors.inkSecondary)
                Text("「このアカウントに保存」を選ぶと、残っている記録をこのアカウントにもバックアップします。自分の記録でない場合は選ばないでください。", style = MaterialTheme.typography.bodyMedium, color = AppColors.inkSecondary)
                androidx.compose.material3.TextButton(onClick = { confirmReplace = true }) { Text("記録を削除して切り替える", color = AppColors.danger) }
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(onClick = onMerge) { Text("このアカウントに保存") } },
        dismissButton = { androidx.compose.material3.TextButton(onClick = onSignOut) { Text("ログアウト") } },
    )
}

/** Shown before the system permission prompts, which appear without any context of their own. */
@Composable
private fun LocationIntroDialog(onStart: () -> Unit, onLater: () -> Unit) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onLater,
        title = { Text("位置情報を記録しますか？", style = MaterialTheme.typography.dialogTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("移動中は10秒、静止中は5分ごとに現在地を記録して、1日の移動と滞在を地図にまとめます。アプリを閉じている間も、通知を表示して記録を続けます。", style = MaterialTheme.typography.bodyMedium, color = AppColors.inkSecondary)
                Text("記録は端末に保存され、ログインしたときだけバックアップされます。次に、位置情報・身体活動（静止の判定に使用）・通知の許可を確認します。記録は設定からいつでも停止できます。", style = MaterialTheme.typography.bodyMedium, color = AppColors.inkSecondary)
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(onClick = onStart) { Text("記録を始める") } },
        dismissButton = { androidx.compose.material3.TextButton(onClick = onLater) { Text("あとで") } },
    )
}

private fun isoTimestamp(value: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}.format(Date(value))
