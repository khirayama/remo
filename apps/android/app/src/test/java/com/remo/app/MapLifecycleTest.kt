package com.remo.app

import org.junit.Assert.assertEquals
import org.junit.Test

class MapLifecycleTest {
    @Test fun lifecycleAndCompositionDisposalDestroyNativeMapExactlyOnce() {
        val calls = mutableListOf<String>()
        val map = MapLifecycle({ calls += "start" }, { calls += "resume" }, { calls += "pause" }, { calls += "stop" }, { calls += "destroy" })
        map.start(); map.resume(); map.pause(); map.stop(); map.destroy()
        map.destroy(); map.pause(); map.stop(); map.resume()
        assertEquals(listOf("start", "resume", "pause", "stop", "destroy"), calls)
    }

    @Test fun disposingVisibleMapClosesInOrderAndBackgroundingCanResume() {
        val calls = mutableListOf<String>()
        val map = MapLifecycle({ calls += "start" }, { calls += "resume" }, { calls += "pause" }, { calls += "stop" }, { calls += "destroy" })
        map.resume(); map.stop(); map.resume(); map.destroy()
        assertEquals(listOf("start", "resume", "pause", "stop", "start", "resume", "pause", "stop", "destroy"), calls)
    }
}
