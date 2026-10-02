package com.remo.app

import android.app.Application
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch

class RemoApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        private val persistenceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        private val persistenceQueue = Channel<suspend () -> Unit>(Channel.UNLIMITED)
        init {
            persistenceScope.launch {
                for (write in persistenceQueue) {
                    try { write() } catch (error: Exception) {
                        android.util.Log.e("RemoPersistence", "Unable to persist recording", error)
                        // Surfaced by the home screen: a full disk must not lose records silently.
                        persistenceFailed = true
                    }
                }
            }
        }

        /** Set when a queued write failed (for example, the disk is full). */
        var persistenceFailed by androidx.compose.runtime.mutableStateOf(false)

        fun enqueuePersistence(write: suspend () -> Unit) {
            persistenceQueue.trySend(write).getOrThrow()
        }
        lateinit var instance: RemoApplication
            private set

        val context: Context
            get() = instance.applicationContext
    }
}
