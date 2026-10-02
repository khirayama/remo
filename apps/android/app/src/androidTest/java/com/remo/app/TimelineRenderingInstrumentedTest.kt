package com.remo.app

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import java.util.Calendar

class TimelineRenderingInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun largeTimelineCanRenderUpdateAndSwitchTabs() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        // This suite runs with -PapplicationId=com.remo.app.optimization so the
        // user's installed app, credentials and recordings remain separate.
        org.junit.Assume.assumeTrue(context.packageName.endsWith(".optimization"))
        AutomaticCaptureService.setEnabled(context, false)
        val start = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis
        val store = LogStore.get(context)
        runBlocking {
            store.reload()
            store.clearAll()
            store.importAll((0 until 2_000).map { index ->
                LogEntry(id = "render-$index", startedAt = start + index * 10_000L,
                    latitude = 35.0 + index * 0.0001, longitude = 139.0, accuracyMeters = 5.0, updatedAt = start)
            })
        }
        compose.setContent { MaterialTheme { TrackerHome(null, {}, { null }) {} } }
        compose.waitUntil(30_000) {
            compose.onAllNodes(androidx.compose.ui.test.hasText("移動", substring = false)).fetchSemanticsNodes().isNotEmpty()
        }
        runBlocking {
            store.add(LogEntry(id = "render-new", startedAt = start + 2_000 * 10_000L,
                latitude = 35.21, longitude = 139.0, accuracyMeters = 5.0, updatedAt = start))
        }
        compose.waitForIdle()
        compose.onNodeWithText("設定").performClick()
        compose.onNodeWithText("記録間隔").assertExists()
        compose.onNodeWithText("Timeline").performClick()
        compose.onNodeWithText("TIMELINE").assertExists()
    }
}
