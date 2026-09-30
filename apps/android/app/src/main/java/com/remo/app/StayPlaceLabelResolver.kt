package com.remo.app

import android.content.Context
import android.location.Geocoder
import com.google.android.gms.maps.model.LatLng
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.Normalizer
import java.util.Locale
import android.os.SystemClock
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private data class CachedPlaceLabel(val label: StayPlaceLabel?, val expiresAt: Long)
private val labelMutex = Mutex()
private val labelCache = object : LinkedHashMap<String, CachedPlaceLabel>(256, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CachedPlaceLabel>): Boolean = size > 256
}

data class StayPlaceLabel(
    val placeName: String?,
    val address: String?,
) {
    val primary: String get() = placeName ?: address ?: "滞在ポイント"
}

/** Resolve labels locally through the device's configured geocoder. */
@Suppress("DEPRECATION")
suspend fun resolveStayPlaceLabel(context: Context, coordinate: LatLng): StayPlaceLabel? = withContext(Dispatchers.IO) {
    labelMutex.withLock {
        val key = "${Locale.getDefault()}|${coordinate.latitude}|${coordinate.longitude}"
        val now = SystemClock.elapsedRealtime()
        labelCache[key]?.takeIf { it.expiresAt > now }?.let { return@withLock it.label }
        val label = lookupStayPlaceLabel(context, coordinate)
        labelCache[key] = CachedPlaceLabel(label, now + if (label == null) 60_000L else 24 * 60 * 60_000L)
        label
    }
}

@Suppress("DEPRECATION")
private fun lookupStayPlaceLabel(context: Context, coordinate: LatLng): StayPlaceLabel? {
    if (!Geocoder.isPresent()) return null
    val address = runCatching {
        Geocoder(context, Locale.getDefault()).getFromLocation(coordinate.latitude, coordinate.longitude, 1)
            ?.firstOrNull()
    }.getOrNull() ?: return null

    val addressLine = displayAddress(address.getAddressLine(0), address.countryName, address.adminArea)
    // Geocoders often return a bare house number ("13") as the feature name;
    // that reads as noise, so fall through to the next meaningful name.
    val placeName = listOf(address.premises, address.featureName, address.thoroughfare, address.subLocality, address.locality)
        .map { it?.let { name -> Normalizer.normalize(name, Normalizer.Form.NFKC).trim() } }
        .firstOrNull { !it.isNullOrEmpty() && !isHouseNumber(it) && it != addressLine }
    // The address line often repeats the building name at its end.
    val shortAddress = placeName?.let { name -> addressLine?.removeSuffix(name)?.trim()?.takeIf(String::isNotEmpty) } ?: addressLine
    return if (placeName == null && shortAddress == null) null else StayPlaceLabel(placeName, shortAddress)
}

private val houseNumberPattern = Regex("^[0-9０-９\\s\\-－−‐ー丁目番地号の]+$")
private val postalCodePattern = Regex("^〒?\\s*[0-9０-９]{3}[-－−]?[0-9０-９]{4}\\s*")

internal fun isHouseNumber(value: String): Boolean = houseNumberPattern.matches(value)

/**
 * Shortens a geocoder address line for display: drops the country, postal code
 * and prefecture, and normalizes full-width digits.
 * "日本、〒810-0024 福岡県福岡市中央区桜坂１丁目" → "福岡市中央区桜坂1丁目"
 */
internal fun displayAddress(line: String?, countryName: String?, adminArea: String? = null): String? {
    var value = line?.let { Normalizer.normalize(it, Normalizer.Form.NFKC) }?.trim() ?: return null
    listOfNotNull(countryName, "日本").forEach { country ->
        value = value.removePrefix("$country、").removePrefix("$country, ").removePrefix(country).trim()
    }
    value = value.replace(postalCodePattern, "").trim()
    adminArea?.let { area -> value.removePrefix(Normalizer.normalize(area, Normalizer.Form.NFKC)).trim().takeIf(String::isNotEmpty)?.let { value = it } }
    return value.takeIf(String::isNotEmpty)
}
