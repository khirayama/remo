package com.remo.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.TriggerEvent
import android.hardware.TriggerEventListener
import android.location.Location
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionEvent
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import java.util.Locale
import java.util.UUID

class AutomaticCaptureService : Service(), SensorEventListener {
    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var sensorManager: SensorManager

    private var mode = CaptureMode.NORMAL
    private var activityRecognitionRegistered = false
    private var activityRecognitionRequestPending = false
    private var activityRecognitionHasState = false
    private var activityState = ActivityState.UNKNOWN
    private var lastActivityStateAt = 0L
    private var stationarySensor: Sensor? = null
    private var lastStationaryDetectedAt = 0L
    private val registeredMotionSensors = mutableSetOf<Sensor>()
    private var significantMotionSensor: Sensor? = null
    private var significantMotionArmed = false

    private data class ObservedLocation(val location: Location, val receivedAtElapsedRealtime: Long)

    private val locationHistory = ArrayDeque<ObservedLocation>()
    private var lastObservedLocation: ObservedLocation? = null
    private var lastAcceptedFixNanos = 0L
    private var lastAcceptedAccuracy = Float.POSITIVE_INFINITY
    private var lastTransitionNanos = 0L
    private var lastLoggedElapsed: Long? = null
    private var lastLoggedEntry: LogEntry? = null
    private var requestedInterval: Long? = null
    private var requestedPriority: Int? = null
    private var locationRequestGeneration = 0L
    private var destroyed = false
    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.locations.forEach { location ->
                handleLocation(location, contributesToStationaryEvidence = true)
            }
        }
    }

    private val sensorTriggerListener = object : TriggerEventListener() {
        override fun onTrigger(event: TriggerEvent) {
            if (destroyed) return
            if (event.sensor.type == Sensor.TYPE_STATIONARY_DETECT) {
                lastStationaryDetectedAt = event.timestamp / 1_000_000L
                maybeEnterStationaryMode(SystemClock.elapsedRealtime())
                if (mode == CaptureMode.NORMAL) registerStationarySensor()
            } else {
                registeredMotionSensors.remove(event.sensor)
                onMovementDetected("motion_detect")
            }
        }
    }

    private val significantMotionListener = object : TriggerEventListener() {
        override fun onTrigger(event: TriggerEvent) {
            significantMotionArmed = false
            onMovementDetected("significant_motion")
            armSignificantMotionSensor()
        }
    }

    override fun onCreate() {
        super.onCreate()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        createChannel()
        registerStationarySensor()
        requestActivityRecognition()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!hasLocationPermission()) {
            preferences(this).edit { putBoolean(KEY_ENABLED, false) }
            stopSelf()
            return START_NOT_STICKY
        }
        if (!isEnabled(this)) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForegroundWithCurrentMode()

        if (intent?.action == ACTION_ACTIVITY_TRANSITION) {
            handleActivityTransition(intent)
            if (requestedInterval == null) requestUpdates()
            return START_STICKY
        }

        preferences(this).edit { putBoolean(KEY_ENABLED, true) }
        requestUpdates()
        requestActivityRecognition()
        return START_STICKY
    }

    @SuppressLint("MissingPermission")
    private fun requestUpdates() {
        if (!hasLocationPermission()) {
            stopSelf()
            return
        }
        val intervalMs = mode.intervalMs
        val priority = mode.priority
        if (requestedInterval == intervalMs && requestedPriority == priority) return

        val generation = ++locationRequestGeneration
        requestedInterval = null
        requestedPriority = null
        fusedLocationClient.removeLocationUpdates(locationCallback).addOnCompleteListener {
            if (destroyed || generation != locationRequestGeneration || !hasLocationPermission() || !isEnabled(this)) return@addOnCompleteListener

            val request = LocationRequest.Builder(priority, intervalMs)
                .setMinUpdateIntervalMillis(intervalMs)
                .setMinUpdateDistanceMeters(0f)
                .setWaitForAccurateLocation(false)
                .build()
            fusedLocationClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
                .addOnSuccessListener {
                    if (!destroyed && generation == locationRequestGeneration) {
                        requestedInterval = intervalMs
                        requestedPriority = priority
                    }
                }
                .addOnFailureListener { error ->
                    if (generation == locationRequestGeneration) {
                        Log.w(TAG, "Unable to request fused location updates: ${error.message}")
                    }
                }
        }
    }

    private fun handleLocation(location: Location, contributesToStationaryEvidence: Boolean) {
        if (destroyed || !isEnabled(this)) return
        if (location.hasAccuracy() && (!location.accuracy.isFinite() || location.accuracy < 0f || location.accuracy > MAX_ACCURACY_M)) return
        if (!hasUsableCoordinates(location.latitude, location.longitude)) return

        val now = System.currentTimeMillis()
        val nowElapsed = SystemClock.elapsedRealtime()
        val sameFixWithBetterAccuracy = location.elapsedRealtimeNanos == lastAcceptedFixNanos && location.hasAccuracy() && location.accuracy < lastAcceptedAccuracy
        if (!CapturePolicy.isFreshFix(location.elapsedRealtimeNanos, SystemClock.elapsedRealtimeNanos(), if (sameFixWithBetterAccuracy) 0L else lastAcceptedFixNanos)) return
        lastAcceptedFixNanos = location.elapsedRealtimeNanos
        lastAcceptedAccuracy = if (location.hasAccuracy()) location.accuracy else Float.POSITIVE_INFINITY
        val movementReason = movementReason(lastObservedLocation?.location, location)
        if (movementReason != null) onMovementDetected(movementReason)
        if (contributesToStationaryEvidence && !sameFixWithBetterAccuracy) observeLocation(ObservedLocation(Location(location), location.elapsedRealtimeNanos / 1_000_000L))
        if (mode == CaptureMode.NORMAL && contributesToStationaryEvidence) maybeEnterStationaryMode(nowElapsed)

        val state = preferences(this)
        val withinInterval = lastLoggedElapsed?.let { nowElapsed - it < mode.intervalMs } == true
        // A coarse provider must not suppress a better GPS fix in the same interval.
        val previousEntry = lastLoggedEntry
        val improvesAccuracy = previousEntry != null && location.hasAccuracy() &&
            location.accuracy < (previousEntry.accuracyMeters ?: Double.POSITIVE_INFINITY) * 0.75 &&
            nowElapsed - (lastLoggedElapsed ?: 0L) <= 2_000L
        if (withinInterval && !improvesAccuracy) return
        val entry = LogEntry(
                id = if (withinInterval) previousEntry!!.id else UUID.randomUUID().toString(),
                startedAt = location.time.takeIf { it > 0L } ?: now,
                latitude = location.latitude,
                longitude = location.longitude,
                accuracyMeters = location.accuracy.takeIf { location.hasAccuracy() && it.isFinite() }?.toDouble(),
                source = EventSource.LOCATION,
                updatedAt = now,
        )
        if (!withinInterval) lastLoggedElapsed = nowElapsed
        lastLoggedEntry = entry
        val store = LogStore.get(this)
        val generation = store.generation
        RemoApplication.enqueuePersistence {
            try {
                store.add(entry, generation)
                state.edit { putLong(KEY_LAST_LOGGED_AT, now) }
                sendBroadcast(Intent(ACTION_AUTOMATIC_LOG_SAVED).setPackage(packageName))
            } catch (error: Exception) {
                Log.e(TAG, "Unable to persist location", error)
            }
        }
    }

    private fun observeLocation(observed: ObservedLocation) {
        lastObservedLocation = observed
        locationHistory.addLast(observed)
        val oldestAllowed = observed.receivedAtElapsedRealtime - STATIONARY_HISTORY_WINDOW_MS
        while (locationHistory.firstOrNull()?.receivedAtElapsedRealtime?.let { it < oldestAllowed } == true) {
            locationHistory.removeFirst()
        }
    }

    private fun movementReason(previous: Location?, current: Location): String? {
        if (current.hasSpeed() && current.speed.isFinite() && current.speed >= MOVEMENT_SPEED_MPS) {
            return "location_speed_${current.speed.formatForReason()}mps"
        }
        if (previous != null) {
            val distance = previous.distanceTo(current)
            if (distance >= MOVEMENT_DISTANCE_M) return "location_distance_${distance.formatForReason()}m"
        }
        return null
    }

    private fun maybeEnterStationaryMode(nowElapsedRealtime: Long) {
        if (mode != CaptureMode.NORMAL) return
        val recentLocations = locationHistory.filter { it.receivedAtElapsedRealtime >= nowElapsedRealtime - STATIONARY_HISTORY_WINDOW_MS }
        val policySamples = recentLocations.map {
            CapturePolicy.Sample(it.receivedAtElapsedRealtime, it.location.latitude, it.location.longitude,
                it.location.speed.takeIf { speed -> it.location.hasSpeed() && speed.isFinite() },
                it.location.accuracy.takeIf { _ -> it.location.hasAccuracy() })
        }
        if (!CapturePolicy.isStationary(policySamples, nowElapsedRealtime)) return
        val origin = recentLocations.first().location
        val maximumDisplacement = recentLocations.maxOf { origin.distanceTo(it.location) }
        val maximumSpeed = recentLocations.mapNotNull { observed -> observed.location.speed.takeIf { speed -> observed.location.hasSpeed() && speed.isFinite() } }.maxOrNull() ?: return

        val stationarySignalIsFresh = stationarySensor == null ||
            (lastStationaryDetectedAt > 0L && nowElapsedRealtime - lastStationaryDetectedAt in 0..STATIONARY_SIGNAL_MAX_AGE_MS)
        if (!stationarySignalIsFresh) return

        val activitySignalIsSafe = when {
            !activityRecognitionHasState -> true
            activityState != ActivityState.STILL -> false
            else -> nowElapsedRealtime - lastActivityStateAt <= ACTIVITY_STATE_MAX_AGE_MS
        }
        if (!activitySignalIsSafe) return

        val reason = buildList {
            add("location_stable_${maximumDisplacement.formatForReason()}m_${recentLocations.size}samples")
            add("speed_near_zero_${maximumSpeed.formatForReason()}mps")
            if (lastStationaryDetectedAt != 0L) add("stationary_detect")
            if (activityState == ActivityState.STILL) add("activity_still")
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!powerManager.isInteractive) add("screen_off")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && powerManager.isDeviceIdleMode) add("device_idle")
        }.joinToString(",")
        enterStationaryMode("quiet_evidence:$reason")
    }

    private fun enterStationaryMode(reason: String) {
        if (mode == CaptureMode.STATIONARY) return
        mode = CaptureMode.STATIONARY
        registerMotionSensors()
        armSignificantMotionSensor()
        val wakeupSensorRegistered = registeredMotionSensors.any { it.isWakeUpSensor && it.type == Sensor.TYPE_MOTION_DETECT }
        if (!wakeupSensorRegistered && !significantMotionArmed && !activityRecognitionRegistered) {
            mode = CaptureMode.NORMAL
            unregisterMotionSensors()
            Log.i(TAG, "stationary mode skipped: no movement wakeup available")
            return
        }
        saveModeReason("enter_5m:$reason")
        requestUpdates()
        startForegroundWithCurrentMode()
    }

    private fun returnToNormalMode(reason: String) {
        if (mode == CaptureMode.NORMAL) return
        mode = CaptureMode.NORMAL
        saveModeReason("return_10s:$reason")
        unregisterMotionSensors()
        registerStationarySensor()
        requestUpdates()
        startForegroundWithCurrentMode()
    }

    private fun onMovementDetected(reason: String) {
        locationHistory.clear()
        lastObservedLocation = null
        lastStationaryDetectedAt = 0L
        if (mode == CaptureMode.STATIONARY) returnToNormalMode(reason)
    }

    private fun registerStationarySensor() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        stationarySensor = runCatching { sensorManager.getDefaultSensor(Sensor.TYPE_STATIONARY_DETECT) }.getOrNull()
        val sensor = stationarySensor ?: run {
            Log.i(TAG, "stationary sensor unavailable; relying on location/speed and Activity Recognition")
            return
        }
        val registered = runCatching {
            if (sensor.reportingMode == Sensor.REPORTING_MODE_ONE_SHOT) sensorManager.requestTriggerSensor(sensorTriggerListener, sensor)
            else sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL)
        }.getOrDefault(false)
        if (!registered) {
            stationarySensor = null
            Log.i(TAG, "stationary sensor registration failed; relying on location/speed and Activity Recognition")
        }
    }

    private fun registerMotionSensors() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        listOf(Sensor.TYPE_MOTION_DETECT, Sensor.TYPE_STEP_DETECTOR).forEach { type ->
            val sensor = runCatching { sensorManager.getDefaultSensor(type, true) ?: sensorManager.getDefaultSensor(type) }.getOrNull() ?: return@forEach
            if (runCatching {
                if (sensor.reportingMode == Sensor.REPORTING_MODE_ONE_SHOT) sensorManager.requestTriggerSensor(sensorTriggerListener, sensor)
                else sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL)
            }.getOrDefault(false)) {
                registeredMotionSensors += sensor
            }
        }
        Log.i(TAG, "low-power motion sensors registered: ${registeredMotionSensors.map { it.type }}")
    }

    private fun unregisterMotionSensors() {
        registeredMotionSensors.forEach {
            if (it.reportingMode == Sensor.REPORTING_MODE_ONE_SHOT) sensorManager.cancelTriggerSensor(sensorTriggerListener, it)
            else sensorManager.unregisterListener(this, it)
        }
        registeredMotionSensors.clear()
        significantMotionSensor?.let { sensorManager.cancelTriggerSensor(significantMotionListener, it) }
        significantMotionArmed = false
    }

    private fun armSignificantMotionSensor() {
        if (mode != CaptureMode.STATIONARY || significantMotionArmed) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.JELLY_BEAN_MR2) return
        if (significantMotionSensor == null) {
            significantMotionSensor = runCatching { sensorManager.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION) }.getOrNull()
        }
        val sensor = significantMotionSensor ?: return
        significantMotionArmed = runCatching { sensorManager.requestTriggerSensor(significantMotionListener, sensor) }.getOrDefault(false)
    }

    @SuppressLint("MissingPermission")
    private fun requestActivityRecognition() {
        if (activityRecognitionRegistered || activityRecognitionRequestPending || !hasActivityRecognitionPermission()) return
        val transitions = MOVING_ACTIVITY_TYPES.flatMap { activityType ->
            listOf(
                ActivityTransition.Builder().setActivityType(activityType).setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER).build(),
                ActivityTransition.Builder().setActivityType(activityType).setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT).build(),
            )
        } + listOf(
            ActivityTransition.Builder().setActivityType(DetectedActivity.STILL).setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER).build(),
            ActivityTransition.Builder().setActivityType(DetectedActivity.STILL).setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT).build(),
        )
        val pendingIntent = activityRecognitionPendingIntent()
        activityRecognitionRequestPending = true
        runCatching {
            ActivityRecognition.getClient(this)
                .requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), pendingIntent)
                .addOnSuccessListener {
                    activityRecognitionRequestPending = false
                    if (destroyed) {
                        ActivityRecognition.getClient(this).removeActivityTransitionUpdates(pendingIntent)
                        return@addOnSuccessListener
                    }
                    activityRecognitionRegistered = true
                    Log.i(TAG, "activity recognition transition monitoring enabled")
                }
                .addOnFailureListener { error ->
                    activityRecognitionRequestPending = false
                    activityRecognitionRegistered = false
                    Log.w(TAG, "activity recognition unavailable: ${error.message}")
                }
        }.onFailure {
            activityRecognitionRequestPending = false
            Log.w(TAG, "activity recognition request failed: ${it.message}")
        }
    }

    private fun handleActivityTransition(intent: Intent) {
        if (!ActivityTransitionResult.hasResult(intent)) return
        val result = runCatching { ActivityTransitionResult.extractResult(intent) }.getOrNull() ?: return
        val now = SystemClock.elapsedRealtime()
        result.transitionEvents.forEach { event -> handleActivityTransitionEvent(event, now) }
    }

    private fun handleActivityTransitionEvent(event: ActivityTransitionEvent, now: Long) {
        if (event.elapsedRealTimeNanos <= lastTransitionNanos) return
        lastTransitionNanos = event.elapsedRealTimeNanos
        if (event.activityType == DetectedActivity.STILL && now - event.elapsedRealTimeNanos / 1_000_000L !in 0..30_000L) return
        val activityName = activityName(event.activityType)
        val isEnter = event.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER
        when {
            event.activityType in MOVING_ACTIVITY_TYPES && isEnter -> {
                activityState = ActivityState.MOVING
                activityRecognitionHasState = true
                lastActivityStateAt = now
                onMovementDetected("activity_${activityName}_enter")
            }
            event.activityType == DetectedActivity.STILL && isEnter -> {
                activityState = ActivityState.STILL
                activityRecognitionHasState = true
                lastActivityStateAt = now
                maybeEnterStationaryMode(now)
            }
            event.activityType == DetectedActivity.STILL && !isEnter -> {
                activityState = ActivityState.UNKNOWN
                activityRecognitionHasState = true
                lastActivityStateAt = now
                onMovementDetected("activity_still_exit")
            }
            event.activityType in MOVING_ACTIVITY_TYPES -> {
                activityState = ActivityState.UNKNOWN
                activityRecognitionHasState = true
                lastActivityStateAt = now
            }
        }
    }

    private fun activityRecognitionPendingIntent(): PendingIntent {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        return PendingIntent.getService(
            this,
            ACTIVITY_RECOGNITION_REQUEST_CODE,
            Intent(this, AutomaticCaptureService::class.java).setAction(ACTION_ACTIVITY_TRANSITION),
            flags,
        )
    }

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_STATIONARY_DETECT -> {
                lastStationaryDetectedAt = event.timestamp / 1_000_000L
                maybeEnterStationaryMode(SystemClock.elapsedRealtime())
            }
            Sensor.TYPE_MOTION_DETECT -> onMovementDetected("motion_detect")
            Sensor.TYPE_STEP_DETECTOR -> onMovementDetected("step_detector")
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun hasLocationPermission(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun hasActivityRecognitionPermission(): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED
    } else {
        ContextCompat.checkSelfPermission(this, ACTIVITY_RECOGNITION_PERMISSION_PRE_Q) == PackageManager.PERMISSION_GRANTED
    }

    private fun startForegroundWithCurrentMode() {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(this, R.color.brand_green))
            .setContentTitle("Remoが位置情報を記録しています")
            .setContentText(mode.notificationText)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openApp)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun saveModeReason(reason: String) {
        val now = System.currentTimeMillis()
        preferences(this).edit {
            putString(KEY_LAST_MODE_REASON, reason)
            putLong(KEY_LAST_MODE_CHANGED_AT, now)
        }
        Log.i(TAG, "capture mode changed: $reason")
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "自動位置記録", NotificationManager.IMPORTANCE_LOW),
        )
    }

    private fun activityName(type: Int): String = when (type) {
        DetectedActivity.IN_VEHICLE -> "in_vehicle"
        DetectedActivity.ON_BICYCLE -> "on_bicycle"
        DetectedActivity.ON_FOOT -> "on_foot"
        DetectedActivity.RUNNING -> "running"
        DetectedActivity.WALKING -> "walking"
        DetectedActivity.STILL -> "still"
        else -> "activity_$type"
    }

    override fun onBind(intent: Intent?): IBinder? = null

    @SuppressLint("MissingPermission")
    override fun onDestroy() {
        destroyed = true
        locationRequestGeneration++
        fusedLocationClient.removeLocationUpdates(locationCallback)
        stationarySensor?.let {
            sensorManager.unregisterListener(this, it)
            sensorManager.cancelTriggerSensor(sensorTriggerListener, it)
        }
        unregisterMotionSensors()
        if (activityRecognitionRegistered || activityRecognitionRequestPending) {
            runCatching { ActivityRecognition.getClient(this).removeActivityTransitionUpdates(activityRecognitionPendingIntent()) }
        }
        super.onDestroy()
    }

    private enum class CaptureMode(val intervalMs: Long, val priority: Int, val notificationText: String) {
        NORMAL(NORMAL_INTERVAL_SECONDS * 1000L, Priority.PRIORITY_HIGH_ACCURACY, "通常モード（10秒ごと）で保存中"),
        STATIONARY(STATIONARY_INTERVAL_SECONDS * 1000L, Priority.PRIORITY_BALANCED_POWER_ACCURACY, "静止モード（5分ごと）で保存中"),
    }

    private enum class ActivityState { UNKNOWN, STILL, MOVING }

    companion object {
        private const val TAG = "AutomaticCaptureService"
        private const val CHANNEL_ID = "rem_automatic_capture"
        const val ACTION_AUTOMATIC_LOG_SAVED = "com.remo.app.ACTION_AUTOMATIC_LOG_SAVED"
        private const val ACTION_ACTIVITY_TRANSITION = "com.remo.app.ACTION_ACTIVITY_TRANSITION"
        private const val NOTIFICATION_ID = 42
        private const val ACTIVITY_RECOGNITION_REQUEST_CODE = 314
        private const val ACTIVITY_RECOGNITION_PERMISSION_PRE_Q = "com.google.android.gms.permission.ACTIVITY_RECOGNITION"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_LAST_LOGGED_AT = "last_logged_at"
        private const val KEY_LAST_MODE_REASON = "last_mode_reason"
        private const val KEY_LAST_MODE_CHANGED_AT = "last_mode_changed_at"

        const val NORMAL_INTERVAL_SECONDS = 10
        const val STATIONARY_INTERVAL_SECONDS = 5 * 60
        private const val MAX_ACCURACY_M = 500f
        private const val STATIONARY_HISTORY_WINDOW_MS = 5 * 60 * 1000L
        private const val STATIONARY_SIGNAL_MAX_AGE_MS = 5 * 60 * 1000L
        private const val ACTIVITY_STATE_MAX_AGE_MS = 10 * 60 * 1000L
        private const val MOVEMENT_DISTANCE_M = 75f
        private const val MOVEMENT_SPEED_MPS = 1.2f

        private val MOVING_ACTIVITY_TYPES = setOf(
            DetectedActivity.IN_VEHICLE,
            DetectedActivity.ON_BICYCLE,
            DetectedActivity.ON_FOOT,
            DetectedActivity.RUNNING,
            DetectedActivity.WALKING,
        )

        private fun preferences(context: Context) = context.getSharedPreferences("rem_automatic_capture", Context.MODE_PRIVATE)

        // Tracking is opt-out. The first screen asks for permission and starts
        // the foreground service as soon as it is granted.
        fun isEnabled(context: Context): Boolean = preferences(context).getBoolean(KEY_ENABLED, true)

        fun setEnabled(context: Context, enabled: Boolean) {
            preferences(context).edit { putBoolean(KEY_ENABLED, enabled) }
            val intent = Intent(context, AutomaticCaptureService::class.java)
            if (enabled) ContextCompat.startForegroundService(context, intent) else context.stopService(intent)
        }

        private fun Float.formatForReason(): String = "%.1f".format(Locale.US, this)
        private fun Double.formatForReason(): String = "%.1f".format(Locale.US, this)
    }
}
