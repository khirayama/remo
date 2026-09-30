package com.remo.app

import android.app.Application
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
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
                    try { write() } catch (error: Exception) { android.util.Log.e("RemoPersistence", "Unable to persist recording", error) }
                }
            }
        }

        fun enqueuePersistence(write: suspend () -> Unit) {
            persistenceQueue.trySend(write).getOrThrow()
        }
        lateinit var instance: RemoApplication
            private set

        val context: Context
            get() = instance.applicationContext
    }
}
