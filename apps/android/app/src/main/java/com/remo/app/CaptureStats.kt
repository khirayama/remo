package com.remo.app

/**
 * Counts what the recording service did between two diagnostics summaries:
 * fixes received, kept and dropped (and why), movement signals, and why the
 * 5-minute mode was not entered.
 */
internal class CaptureStats {
    var startedElapsed = 0L
    var received = 0
    var logged = 0
    private val dropped = sortedMapOf<String, Int>()
    private val signals = sortedMapOf<String, Int>()
    private val evidence = sortedMapOf<String, Int>()
    private val accuracies = mutableListOf<Float>()
    private val speeds = mutableListOf<Float>()
    private var maxDeliveryDelayMs = 0L

    val isEmpty: Boolean get() = received == 0 && signals.isEmpty()

    fun drop(reason: String) = count(dropped, reason)

    fun signal(name: String) = count(signals, name)

    /** The outcome of one stationary check; `ok` and `resumed` mean it passed. */
    fun evidence(reason: String) = count(evidence, reason)

    fun accepted(accuracyM: Float?, speedMps: Float?, deliveryDelayMs: Long) {
        accuracyM?.let(accuracies::add)
        speedMps?.let(speeds::add)
        maxDeliveryDelayMs = maxOf(maxDeliveryDelayMs, deliveryDelayMs)
    }

    fun fields(nowElapsed: Long): Map<String, Any?> = mapOf(
        "periodMs" to nowElapsed - startedElapsed,
        "received" to received,
        "logged" to logged,
        "dropped" to dropped.toMap().takeIf { it.isNotEmpty() },
        "signals" to signals.toMap().takeIf { it.isNotEmpty() },
        "evidence" to evidence.toMap().takeIf { it.isNotEmpty() },
        "accuracyMedianM" to percentile(accuracies, 0.5),
        "accuracyP90M" to percentile(accuracies, 0.9),
        "speedMedianMps" to percentile(speeds, 0.5),
        "speedMaxMps" to speeds.maxOrNull(),
        "deliveryDelayMaxMs" to maxDeliveryDelayMs.takeIf { received > 0 },
    )

    fun reset(nowElapsed: Long) {
        startedElapsed = nowElapsed
        received = 0
        logged = 0
        dropped.clear()
        signals.clear()
        evidence.clear()
        accuracies.clear()
        speeds.clear()
        maxDeliveryDelayMs = 0L
    }

    private fun count(counts: MutableMap<String, Int>, key: String) {
        counts[key] = (counts[key] ?: 0) + 1
    }

    private fun percentile(values: List<Float>, share: Double): Float? =
        values.sorted().let { sorted -> sorted.getOrNull(((sorted.size - 1) * share).toInt()) }
}
