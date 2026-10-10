package com.remo.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.ActivityManager
import android.app.AlarmManager
import android.app.ApplicationExitInfo
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.TriggerEvent
import android.hardware.TriggerEventListener
import android.location.Location
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionEvent
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.DetectedActivity
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationAvailability
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
    private var modeChangedElapsed = 0L
    private var activityRecognitionRegistered = false
    private var activityRecognitionRequestPending = false
    private var activityState = ActivityState.UNKNOWN
    private var activityMovingElapsed = 0L
    private val registeredMotionSensors = mutableSetOf<Sensor>()
    private var significantMotionSensor: Sensor? = null
    private var significantMotionArmed = false
    private val stepWindow = CapturePolicy.StepWindow()

    private val locationHistory = ArrayDeque<CapturePolicy.Sample>()
    /** The stay the 5-minute mode is holding, kept for a while after it ends. */
    private var anchor: CapturePolicy.Anchor? = null
    private var anchorLeftElapsed = 0L
    private var awaitingFirstFixAfterReturn = false
    private var lastAcceptedFixNanos = 0L
    private var lastAcceptedAccuracy = Float.POSITIVE_INFINITY
    private var lastAcceptedFixElapsed = 0L
    private var currentLocationRequestPending = false
    private var lastVerificationElapsed = 0L
    private var lastTransitionNanos = 0L
    private var lastLoggedFixElapsed: Long? = null
    private var lastLoggedEntry: LogEntry? = null
    private var requestedInterval: Long? = null
    private var requestedPriority: Int? = null
    private var locationAvailable: Boolean? = null
    private var heartbeatScheduled = false
    private var locationRequestGeneration = 0L
    private var destroyed = false
    private val stats = CaptureStats()
    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.locations.forEach { location -> handleLocation(location, "updates") }
        }

        override fun onLocationAvailability(availability: LocationAvailability) {
            locationAvailable = availability.isLocationAvailable
        }
    }

    private val sensorTriggerListener = object : TriggerEventListener() {
        override fun onTrigger(event: TriggerEvent) {
            if (destroyed) return
            // One-shot sensors disarm themselves; the next fix or heartbeat arms them again.
            registeredMotionSensors.remove(event.sensor)
            onWeakMovement("motion_detect")
        }
    }

    private val significantMotionListener = object : TriggerEventListener() {
        override fun onTrigger(event: TriggerEvent) {
            significantMotionArmed = false
            if (destroyed) return
            onStrongMovement("significant_motion")
            armSignificantMotionSensor()
        }
    }

    override fun onCreate() {
        super.onCreate()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        modeChangedElapsed = SystemClock.elapsedRealtime()
        stats.startedElapsed = modeChangedElapsed
        lastAcceptedFixElapsed = modeChangedElapsed
        createChannel()
        logServiceStart()
        requestActivityRecognition()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!hasLocationPermission()) {
            diagnose("service_stop", mapOf("reason" to "no_location_permission"))
            preferences(this).edit { putBoolean(KEY_ENABLED, false) }
            stopSelf()
            return START_NOT_STICKY
        }
        if (!isEnabled(this)) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForegroundWithCurrentMode()
        if (!heartbeatScheduled) scheduleHeartbeat()

        if (intent?.action == ACTION_ACTIVITY_TRANSITION) {
            handleActivityTransition(intent)
            if (requestedInterval == null) requestUpdates()
            return START_STICKY
        }
        if (intent?.action == ACTION_HEARTBEAT) {
            handleHeartbeat()
            if (requestedInterval == null) requestUpdates()
            return START_STICKY
        }

        // A null intent is the system bringing the service back after it killed the process.
        if (intent == null) diagnose("service_restarted_by_system")
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
                        diagnose("location_request_failed", mapOf("error" to error.message, "mode" to mode.wireName))
                    }
                }
        }
    }

    /** [origin] is where the fix came from: `updates`, `heartbeat` or `verify:<signal>`. */
    private fun handleLocation(location: Location, origin: String) {
        if (destroyed || !isEnabled(this)) return
        stats.received += 1
        if (location.hasAccuracy() && (!location.accuracy.isFinite() || location.accuracy < 0f || location.accuracy > MAX_ACCURACY_M)) return stats.drop("accuracy")
        if (!hasUsableCoordinates(location.latitude, location.longitude)) return stats.drop("coordinates")

        val now = System.currentTimeMillis()
        val nowElapsed = SystemClock.elapsedRealtime()
        val fixElapsed = location.elapsedRealtimeNanos / 1_000_000L
        val accuracy = location.accuracy.takeIf { location.hasAccuracy() && it.isFinite() }
        val speed = location.speed.takeIf { location.hasSpeed() && it.isFinite() }
        val sameFixWithBetterAccuracy = location.elapsedRealtimeNanos == lastAcceptedFixNanos && accuracy != null && accuracy < lastAcceptedAccuracy
        // The 5-minute mode gets low-power fixes that can already be minutes old on delivery;
        // rejecting them left the whole stay without a single record.
        if (!CapturePolicy.isFreshFix(location.elapsedRealtimeNanos, SystemClock.elapsedRealtimeNanos(), if (sameFixWithBetterAccuracy) 0L else lastAcceptedFixNanos, mode.maxFixAgeMs * 1_000_000L)) return stats.drop("stale")
        lastAcceptedFixNanos = location.elapsedRealtimeNanos
        lastAcceptedFixElapsed = nowElapsed
        lastAcceptedAccuracy = accuracy ?: Float.POSITIVE_INFINITY
        stats.accepted(accuracy, speed, nowElapsed - fixElapsed)
        if (!sameFixWithBetterAccuracy) observeLocation(CapturePolicy.Sample(fixElapsed, location.latitude, location.longitude, speed, accuracy))

        val heldAnchor = anchor
        if (awaitingFirstFixAfterReturn && heldAnchor != null) {
            // How far the device got before the 5-minute mode noticed: the cost of a late wake-up.
            awaitingFirstFixAfterReturn = false
            diagnose("first_fix_after_return", mapOf(
                "beyondAnchorM" to CapturePolicy.distanceBeyondAnchor(heldAnchor, location.latitude, location.longitude, accuracy),
                "accuracyM" to accuracy, "sinceReturnMs" to nowElapsed - anchorLeftElapsed,
            ))
        }
        if (mode == CaptureMode.STATIONARY) {
            registerMotionSensors()
            armSignificantMotionSensor()
            if (heldAnchor != null) {
                val beyond = CapturePolicy.distanceBeyondAnchor(heldAnchor, location.latitude, location.longitude, accuracy)
                if (CapturePolicy.leftAnchor(heldAnchor, location.latitude, location.longitude, accuracy)) {
                    onStrongMovement("left_anchor_${beyond.formatForReason()}m")
                } else if (origin.startsWith("verify")) {
                    diagnose("verified_still", mapOf("signal" to origin.substringAfter(':', ""), "beyondAnchorM" to beyond, "accuracyM" to accuracy))
                }
            }
        } else {
            maybeEnterStationaryMode(nowElapsed)
        }
        maybeLogSummary(nowElapsed)

        val state = preferences(this)
        val previousEntry = lastLoggedEntry
        // Measured between the fixes, not their deliveries: a fix that arrives late must
        // not make the next one look early and cost every third record while moving.
        val sinceLastLogged = lastLoggedFixElapsed?.let { fixElapsed - it }
        val withinInterval = sinceLastLogged != null && CapturePolicy.isWithinLoggingInterval(sinceLastLogged, mode.intervalMs)
        // A coarse provider must not suppress a better GPS fix in the same interval.
        val improvesAccuracy = previousEntry != null && accuracy != null && sinceLastLogged != null &&
            accuracy < (previousEntry.accuracyMeters ?: Double.POSITIVE_INFINITY) * 0.75 &&
            sinceLastLogged in 0..2_000L
        if (withinInterval && !improvesAccuracy) return stats.drop("interval")
        if (!withinInterval && sinceLastLogged != null && CapturePolicy.isRedundantCoarseFix(accuracy, previousEntry?.accuracyMeters, sinceLastLogged)) return stats.drop("coarse")
        val entry = LogEntry(
                id = if (withinInterval) previousEntry!!.id else UUID.randomUUID().toString(),
                startedAt = location.time.takeIf { it > 0L } ?: now,
                latitude = location.latitude,
                longitude = location.longitude,
                accuracyMeters = accuracy?.toDouble(),
                source = EventSource.LOCATION,
                updatedAt = now,
        )
        if (!withinInterval) lastLoggedFixElapsed = fixElapsed
        lastLoggedEntry = entry
        stats.logged += 1
        val store = LogStore.get(this)
        val generation = store.generation
        RemoApplication.enqueuePersistence {
            // A failure propagates to the persistence queue, which reports it to the user.
            store.add(entry, generation)
            state.edit { putLong(KEY_LAST_LOGGED_AT, now) }
            sendBroadcast(Intent(ACTION_AUTOMATIC_LOG_SAVED).setPackage(packageName))
        }
    }

    private fun observeLocation(sample: CapturePolicy.Sample) {
        locationHistory.addLast(sample)
        val oldestAllowed = sample.elapsedRealtimeMs - CapturePolicy.STATIONARY_HISTORY_WINDOW_MS
        while (locationHistory.firstOrNull()?.elapsedRealtimeMs?.let { it < oldestAllowed } == true) {
            locationHistory.removeFirst()
        }
    }

    private fun maybeEnterStationaryMode(nowElapsedRealtime: Long) {
        if (mode != CaptureMode.NORMAL) return
        // The stay that was just interrupted is confirmed again faster while it is recent.
        val resumeAnchor = anchor?.takeIf { nowElapsedRealtime - anchorLeftElapsed <= RESUME_ANCHOR_MAX_AGE_MS }
        val evidence = CapturePolicy.stationaryEvidence(locationHistory.toList(), nowElapsedRealtime, resumeAnchor)
        if (!evidence.stationary) return stats.evidence(evidence.reason)

        // An activity transition is reported once. A vehicle waiting at a light is
        // still "in vehicle", so recent movement outweighs fixes that stand still.
        if (activityState == ActivityState.MOVING && nowElapsedRealtime - activityMovingElapsed <= ACTIVITY_MOVING_HOLD_MS) {
            return stats.evidence("activity_moving")
        }
        stats.evidence(evidence.reason)

        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        enterStationaryMode(evidence, mapOf(
            "evidence" to evidence.reason,
            "samples" to evidence.sampleCount,
            "spanMs" to evidence.spanMs,
            "anchorRadiusM" to evidence.anchor?.radiusMeters,
            "activity" to activityState.name.lowercase(),
            "screenOn" to powerManager.isInteractive,
            "deviceIdle" to powerManager.isDeviceIdleMode,
            "sinceNormalMs" to nowElapsedRealtime - modeChangedElapsed,
        ))
    }

    private fun enterStationaryMode(evidence: CapturePolicy.StationaryEvidence, details: Map<String, Any?>) {
        if (mode == CaptureMode.STATIONARY) return
        mode = CaptureMode.STATIONARY
        registerMotionSensors()
        armSignificantMotionSensor()
        val wakeupSensorRegistered = registeredMotionSensors.any { it.isWakeUpSensor && it.type == Sensor.TYPE_MOTION_DETECT }
        if (!wakeupSensorRegistered && !significantMotionArmed && !activityRecognitionRegistered) {
            mode = CaptureMode.NORMAL
            unregisterMotionSensors()
            stats.evidence("no_wakeup_source")
            return
        }
        logSummary(SystemClock.elapsedRealtime(), CaptureMode.NORMAL)
        anchor = evidence.anchor
        awaitingFirstFixAfterReturn = false
        stepWindow.clear()
        modeChangedElapsed = SystemClock.elapsedRealtime()
        saveModeReason("enter_5m:${evidence.reason}")
        diagnose("mode", details + mapOf(
            "to" to mode.wireName,
            "motionSensors" to registeredMotionSensors.joinToString(",") { "${it.type}${if (it.isWakeUpSensor) "w" else ""}" },
            "significantMotion" to significantMotionArmed,
            "activityRecognition" to activityRecognitionRegistered,
        ))
        lastAcceptedFixElapsed = modeChangedElapsed
        requestUpdates()
        scheduleHeartbeat()
        startForegroundWithCurrentMode()
    }

    private fun returnToNormalMode(reason: String) {
        if (mode == CaptureMode.NORMAL) return
        val nowElapsed = SystemClock.elapsedRealtime()
        logSummary(nowElapsed, CaptureMode.STATIONARY)
        mode = CaptureMode.NORMAL
        saveModeReason("return_10s:$reason")
        diagnose("mode", mapOf("to" to mode.wireName, "reason" to reason, "stationaryMs" to nowElapsed - modeChangedElapsed))
        modeChangedElapsed = nowElapsed
        anchorLeftElapsed = nowElapsed
        lastAcceptedFixElapsed = nowElapsed
        awaitingFirstFixAfterReturn = true
        // The sparse fixes of the stay cannot prove anything about the next minutes.
        locationHistory.clear()
        scheduleHeartbeat()
        unregisterMotionSensors()
        requestUpdates()
        startForegroundWithCurrentMode()
    }

    /** A signal that means the device is travelling: the 5-minute mode ends at once. */
    private fun onStrongMovement(reason: String) {
        stats.signal(if (reason.startsWith("left_anchor")) "left_anchor" else reason)
        if (mode == CaptureMode.STATIONARY) returnToNormalMode(reason)
    }

    /**
     * A signal that fires just as well when the phone is picked up off the desk.
     * Leaving the 5-minute mode for each one kept the GPS on all day, so the stay
     * is checked with a single low-power fix instead; it ends only when that fix
     * (or a strong signal) shows the device has left.
     */
    private fun onWeakMovement(reason: String) {
        stats.signal(reason)
        if (mode != CaptureMode.STATIONARY) return
        val nowElapsed = SystemClock.elapsedRealtime()
        if (currentLocationRequestPending || nowElapsed - lastVerificationElapsed < VERIFICATION_COOLDOWN_MS) return
        lastVerificationElapsed = nowElapsed
        requestCurrentLocation("verify:$reason", Priority.PRIORITY_BALANCED_POWER_ACCURACY, VERIFICATION_TIMEOUT_MS)
    }

    private fun heartbeatPendingIntent(): PendingIntent = PendingIntent.getService(
        this,
        HEARTBEAT_REQUEST_CODE,
        Intent(this, AutomaticCaptureService::class.java).setAction(ACTION_HEARTBEAT),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun scheduleHeartbeat() {
        val alarmManager = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.setAndAllowWhileIdle(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            SystemClock.elapsedRealtime() + HEARTBEAT_MS,
            heartbeatPendingIntent(),
        )
        heartbeatScheduled = true
    }

    private fun cancelHeartbeat() {
        (getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(heartbeatPendingIntent())
        heartbeatScheduled = false
    }

    /**
     * Fixes are the only thing that drives this service, and a device may stop delivering
     * them: in the 5-minute mode (Doze, no Wi-Fi fix, a sensor that never fires), and in
     * the 10-second mode too, where a request made right after an app update once stayed
     * silent for 17 hours. This alarm still fires while idle, so a silent service asks for
     * one fix itself: it keeps the record going and, when the device has left a stay,
     * returns to the 10-second mode. A silent 10-second request is also made again.
     */
    private fun handleHeartbeat() {
        if (destroyed) return
        scheduleHeartbeat()
        val nowElapsed = SystemClock.elapsedRealtime()
        if (mode == CaptureMode.STATIONARY) {
            registerMotionSensors()
            armSignificantMotionSensor()
        }
        val silentMs = nowElapsed - lastAcceptedFixElapsed
        if (mode == CaptureMode.STATIONARY) {
            maybeLogSummary(nowElapsed)
            if (!CapturePolicy.isStationarySilent(silentMs, mode.intervalMs)) return
            stats.signal("heartbeat_fix")
        } else {
            if (silentMs < NORMAL_SILENCE_MS) return maybeLogSummary(nowElapsed)
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            stats.signal("watchdog_fix")
            diagnose("silent", mapOf(
                "mode" to mode.wireName,
                "silentMs" to silentMs,
                "requestActive" to (requestedInterval != null),
                "locationAvailable" to locationAvailable,
                "screenOn" to powerManager.isInteractive,
                "deviceIdle" to powerManager.isDeviceIdleMode,
            ))
            maybeLogSummary(nowElapsed)
            requestedInterval = null
            requestedPriority = null
            requestUpdates()
        }
        requestCurrentLocation("heartbeat", Priority.PRIORITY_HIGH_ACCURACY, CURRENT_LOCATION_TIMEOUT_MS)
    }

    @SuppressLint("MissingPermission")
    private fun requestCurrentLocation(origin: String, priority: Int, timeoutMs: Long) {
        if (currentLocationRequestPending || !hasLocationPermission()) return
        // Nothing else keeps the CPU awake until the fix arrives.
        val wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "remo:stationary_fix")
        wakeLock.acquire(timeoutMs + 5_000L)
        val request = CurrentLocationRequest.Builder()
            .setPriority(priority)
            .setDurationMillis(timeoutMs)
            .setMaxUpdateAgeMillis(CURRENT_LOCATION_MAX_AGE_MS)
            .build()
        currentLocationRequestPending = true
        runCatching {
            fusedLocationClient.getCurrentLocation(request, null).addOnCompleteListener { task ->
                currentLocationRequestPending = false
                val location = if (task.isSuccessful) task.result else null
                if (location != null) handleLocation(location, origin)
                else diagnose("no_fix", mapOf("origin" to origin, "error" to task.exception?.message))
                if (wakeLock.isHeld) wakeLock.release()
            }
        }.onFailure {
            currentLocationRequestPending = false
            if (wakeLock.isHeld) wakeLock.release()
            diagnose("no_fix", mapOf("origin" to origin, "error" to it.message))
        }
    }

    /** Arms every motion sensor that is not armed yet; safe to call repeatedly. */
    private fun registerMotionSensors() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        listOf(Sensor.TYPE_MOTION_DETECT, Sensor.TYPE_STEP_DETECTOR).forEach { type ->
            if (registeredMotionSensors.any { it.type == type }) return@forEach
            val sensor = runCatching { sensorManager.getDefaultSensor(type, true) ?: sensorManager.getDefaultSensor(type) }.getOrNull() ?: return@forEach
            if (runCatching {
                if (sensor.reportingMode == Sensor.REPORTING_MODE_ONE_SHOT) sensorManager.requestTriggerSensor(sensorTriggerListener, sensor)
                else sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL)
            }.getOrDefault(false)) {
                registeredMotionSensors += sensor
            }
        }
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
                }
                .addOnFailureListener { error ->
                    activityRecognitionRequestPending = false
                    activityRecognitionRegistered = false
                    diagnose("activity_recognition_unavailable", mapOf("error" to error.message))
                }
        }.onFailure {
            activityRecognitionRequestPending = false
            diagnose("activity_recognition_unavailable", mapOf("error" to it.message))
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
        val eventElapsed = event.elapsedRealTimeNanos / 1_000_000L
        val ageMs = now - eventElapsed
        val activityName = activityName(event.activityType)
        val isEnter = event.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER
        diagnose("activity", mapOf("type" to activityName, "enter" to isEnter, "ageMs" to ageMs, "mode" to mode.wireName))
        when {
            event.activityType in MOVING_ACTIVITY_TYPES && isEnter -> {
                activityState = ActivityState.MOVING
                activityMovingElapsed = eventElapsed
                // Transitions can be delivered minutes late; an old one is checked, not trusted.
                if (ageMs in 0..ACTIVITY_EVENT_MAX_AGE_MS) onStrongMovement("activity_${activityName}_enter")
                else onWeakMovement("activity_${activityName}_enter_late")
            }
            event.activityType == DetectedActivity.STILL && isEnter -> {
                activityState = ActivityState.STILL
                maybeEnterStationaryMode(now)
            }
            event.activityType == DetectedActivity.STILL && !isEnter -> {
                activityState = ActivityState.UNKNOWN
                onWeakMovement("activity_still_exit")
            }
            event.activityType in MOVING_ACTIVITY_TYPES -> {
                activityState = ActivityState.UNKNOWN
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
        if (destroyed) return
        when (event.sensor.type) {
            Sensor.TYPE_MOTION_DETECT -> onWeakMovement("motion_detect")
            Sensor.TYPE_STEP_DETECTOR -> {
                if (stepWindow.add(event.timestamp / 1_000_000L)) {
                    stepWindow.clear()
                    onStrongMovement("steps")
                } else {
                    onWeakMovement("step")
                }
            }
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
    }

    private fun diagnose(event: String, fields: Map<String, Any?> = emptyMap()) = CaptureDiagnostics.log(this, event, fields)

    /** Why the previous process ended, and what this device offers for waking up from a stay. */
    private fun logServiceStart() {
        val state = preferences(this)
        val lastLoggedAt = state.getLong(KEY_LAST_LOGGED_AT, 0L)
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        fun sensor(type: Int) = runCatching { sensorManager.getDefaultSensor(type, true) ?: sensorManager.getDefaultSensor(type) }.getOrNull()
            ?.let { if (it.isWakeUpSensor) "wakeup" else "non_wakeup" } ?: "none"
        diagnose("service_start", mapOf(
            "app" to BuildConfig.VERSION_NAME,
            "sdk" to Build.VERSION.SDK_INT,
            "device" to "${Build.MANUFACTURER} ${Build.MODEL}",
            "sinceLastRecordMs" to if (lastLoggedAt > 0L) System.currentTimeMillis() - lastLoggedAt else null,
            "lastExit" to lastProcessExit(),
            "fineLocation" to (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED),
            "backgroundLocation" to (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED),
            "activityRecognition" to hasActivityRecognitionPermission(),
            "batteryOptimized" to !powerManager.isIgnoringBatteryOptimizations(packageName),
            "motionDetect" to sensor(Sensor.TYPE_MOTION_DETECT),
            "stepDetector" to sensor(Sensor.TYPE_STEP_DETECTOR),
            "significantMotion" to sensor(Sensor.TYPE_SIGNIFICANT_MOTION),
        ))
    }

    private fun lastProcessExit(): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val exit = runCatching {
            (getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getHistoricalProcessExitReasons(packageName, 0, 1).firstOrNull()
        }.getOrNull() ?: return null
        val reason = when (exit.reason) {
            ApplicationExitInfo.REASON_LOW_MEMORY -> "low_memory"
            ApplicationExitInfo.REASON_USER_REQUESTED -> "user_requested"
            ApplicationExitInfo.REASON_USER_STOPPED -> "user_stopped"
            ApplicationExitInfo.REASON_CRASH -> "crash"
            ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash_native"
            ApplicationExitInfo.REASON_ANR -> "anr"
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive_resource_usage"
            ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission_change"
            ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "package_updated"
            ApplicationExitInfo.REASON_SIGNALED -> "signaled"
            ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency_died"
            ApplicationExitInfo.REASON_OTHER -> "other"
            else -> "reason_${exit.reason}"
        }
        return "$reason@${exit.timestamp}:${exit.description.orEmpty()}"
    }

    private fun maybeLogSummary(nowElapsed: Long) {
        if (nowElapsed - stats.startedElapsed >= SUMMARY_INTERVAL_MS) logSummary(nowElapsed, mode)
    }

    /** One line per few minutes (and per mode change) with everything needed to judge a recording. */
    private fun logSummary(nowElapsed: Long, summarizedMode: CaptureMode) {
        if (stats.isEmpty && nowElapsed - stats.startedElapsed < SUMMARY_INTERVAL_MS) {
            stats.reset(nowElapsed)
            return
        }
        val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        diagnose("summary", stats.fields(nowElapsed) + mapOf(
            "mode" to summarizedMode.wireName,
            "activity" to activityState.name.lowercase(),
            "batteryPct" to if (level >= 0 && scale > 0) level * 100.0 / scale else null,
            "charging" to ((battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0),
            "screenOn" to powerManager.isInteractive,
            "deviceIdle" to powerManager.isDeviceIdleMode,
        ))
        stats.reset(nowElapsed)
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

    override fun onTaskRemoved(rootIntent: Intent?) {
        diagnose("task_removed")
        super.onTaskRemoved(rootIntent)
    }

    @SuppressLint("MissingPermission")
    override fun onDestroy() {
        logSummary(SystemClock.elapsedRealtime(), mode)
        diagnose("service_destroy", mapOf("enabled" to isEnabled(this), "mode" to mode.wireName))
        destroyed = true
        locationRequestGeneration++
        fusedLocationClient.removeLocationUpdates(locationCallback)
        unregisterMotionSensors()
        cancelHeartbeat()
        if (activityRecognitionRegistered || activityRecognitionRequestPending) {
            runCatching { ActivityRecognition.getClient(this).removeActivityTransitionUpdates(activityRecognitionPendingIntent()) }
        }
        super.onDestroy()
    }

    private enum class CaptureMode(val wireName: String, val intervalMs: Long, val maxFixAgeMs: Long, val priority: Int, val notificationText: String) {
        NORMAL("normal", NORMAL_INTERVAL_SECONDS * 1000L, 30_000L, Priority.PRIORITY_HIGH_ACCURACY, "通常モード（10秒ごと）で保存中"),
        STATIONARY("stationary", STATIONARY_INTERVAL_SECONDS * 1000L, STATIONARY_INTERVAL_SECONDS * 1000L, Priority.PRIORITY_BALANCED_POWER_ACCURACY, "静止モード（5分ごと）で保存中"),
    }

    private enum class ActivityState { UNKNOWN, STILL, MOVING }

    companion object {
        private const val CHANNEL_ID = "rem_automatic_capture"
        const val ACTION_AUTOMATIC_LOG_SAVED = "com.remo.app.ACTION_AUTOMATIC_LOG_SAVED"
        private const val ACTION_ACTIVITY_TRANSITION = "com.remo.app.ACTION_ACTIVITY_TRANSITION"
        private const val NOTIFICATION_ID = 42
        private const val ACTION_HEARTBEAT = "com.remo.app.ACTION_HEARTBEAT"
        private const val ACTIVITY_RECOGNITION_REQUEST_CODE = 314
        private const val HEARTBEAT_REQUEST_CODE = 315
        private const val ACTIVITY_RECOGNITION_PERMISSION_PRE_Q = "com.google.android.gms.permission.ACTIVITY_RECOGNITION"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_LAST_LOGGED_AT = "last_logged_at"
        private const val KEY_LAST_MODE_REASON = "last_mode_reason"
        private const val KEY_LAST_MODE_CHANGED_AT = "last_mode_changed_at"

        const val NORMAL_INTERVAL_SECONDS = 10
        const val STATIONARY_INTERVAL_SECONDS = 5 * 60
        private const val MAX_ACCURACY_M = 500f
        private const val HEARTBEAT_MS = 6 * 60 * 1000L
        private const val NORMAL_SILENCE_MS = 2 * 60 * 1000L
        private const val CURRENT_LOCATION_TIMEOUT_MS = 30_000L
        private const val CURRENT_LOCATION_MAX_AGE_MS = 30_000L
        private const val VERIFICATION_TIMEOUT_MS = 15_000L
        private const val VERIFICATION_COOLDOWN_MS = 2 * 60 * 1000L
        private const val RESUME_ANCHOR_MAX_AGE_MS = 10 * 60 * 1000L
        private const val ACTIVITY_MOVING_HOLD_MS = 10 * 60 * 1000L
        private const val ACTIVITY_EVENT_MAX_AGE_MS = 2 * 60 * 1000L
        private const val SUMMARY_INTERVAL_MS = 5 * 60 * 1000L

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
    }
}
