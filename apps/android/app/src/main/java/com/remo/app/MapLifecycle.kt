package com.remo.app

/** Compose disposal and Activity destruction may both arrive for the same map. */
internal class MapLifecycle(
    private val onStart: () -> Unit,
    private val onResume: () -> Unit,
    private val onPause: () -> Unit,
    private val onStop: () -> Unit,
    private val onDestroy: () -> Unit,
) {
    private var started = false
    private var resumed = false
    var destroyed = false
        private set

    fun start() { if (!destroyed && !started) { onStart(); started = true } }
    fun resume() { if (!destroyed && !resumed) { start(); onResume(); resumed = true } }
    fun pause() { if (resumed) { onPause(); resumed = false } }
    fun stop() { pause(); if (started) { onStop(); started = false } }
    fun destroy() { if (!destroyed) { stop(); onDestroy(); destroyed = true } }
}
