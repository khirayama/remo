package com.remo.app

import android.app.Activity
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat

/**
 * Design tokens. Deep forest green carries the brand; the mint from the
 * launcher mark is reserved for small "live" accents. Movement, stays and
 * photos each own one hue so the map and the timeline read the same way.
 */
object AppColors {
    /** Follows the system appearance; set by [RemoTheme]. */
    internal var dark by mutableStateOf(false)

    private fun pick(light: Long, night: Long) = Color(if (dark) night else light)

    val background get() = pick(0xFFF4F5F1, 0xFF0F1512)
    val surface get() = pick(0xFFFFFFFF, 0xFF18201C)
    val surfaceMuted get() = pick(0xFFF0F2EE, 0xFF222C27)
    val outline get() = pick(0xFFE2E7E1, 0xFF2C3832)
    val outlineStrong get() = pick(0xFFC9D2C9, 0xFF46564D)

    val ink get() = pick(0xFF14291F, 0xFFE6ECE7)
    val inkSecondary get() = pick(0xFF55635A, 0xFFB6C1B9)
    val inkTertiary get() = pick(0xFF7E8A82, 0xFF8D9A91)

    val green get() = pick(0xFF2F5A45, 0xFF86D3A9)
    /** Text and icons on a [green] fill. */
    val onGreen get() = pick(0xFFFFFFFF, 0xFF0F2A1D)
    val greenContainer get() = pick(0xFFDFECE2, 0xFF264536)
    val onGreenContainer get() = pick(0xFF16352A, 0xFFCFE9D8)
    val mint = Color(0xFF1FCFA8)

    val teal get() = pick(0xFF0E8577, 0xFF58CBB9)
    val tealContainer get() = pick(0xFFD9F0EB, 0xFF173F39)
    val amber get() = pick(0xFF9E6A2C, 0xFFE3B578)
    val amberContainer get() = pick(0xFFF5EADB, 0xFF47361E)

    val danger get() = pick(0xFFB3261E, 0xFFF2B8B5)
    val dangerContainer get() = pick(0xFFFBEAE8, 0xFF5C2420)

    // The sign-in hero and photo viewer are dark in both appearances.
    val night get() = pick(0xFF10261D, 0xFF0B1410)
    val onNight = Color(0xFFF2F5F0)
    val onNightMuted = Color(0xB3F2F5F0)
}

/** Colors drawn on the map: lighter marks keep their contrast on the dark map. */
object MapColors {
    val routeRgb get() = if (AppColors.dark) 0x58CBB9 else 0x0E8577
    val focusRouteRgb get() = if (AppColors.dark) 0xA0EBDE else 0x085E54
    val stayRgb get() = if (AppColors.dark) 0x86D3A9 else 0x2F5A45
    fun argb(alpha: Int, rgb: Int): Int = (alpha.coerceIn(0, 255) shl 24) or rgb
}

private val baseTypography = Typography()

/**
 * Everything is set in the platform gothic (sans) face; headings get their
 * hierarchy from weight rather than a second family.
 */
val RemoTypography = Typography(
    displaySmall = baseTypography.displaySmall.copy(fontSize = 30.sp, lineHeight = 40.sp, fontWeight = FontWeight.Bold),
    headlineSmall = baseTypography.headlineSmall.copy(fontSize = 22.sp, lineHeight = 30.sp, fontWeight = FontWeight.Bold),
    titleLarge = baseTypography.titleLarge.copy(fontSize = 20.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
    titleMedium = baseTypography.titleMedium.copy(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = baseTypography.titleSmall.copy(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = baseTypography.bodyLarge.copy(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = baseTypography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = baseTypography.bodySmall.copy(fontSize = 12.sp, lineHeight = 17.sp),
    labelLarge = baseTypography.labelLarge.copy(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelMedium = baseTypography.labelMedium.copy(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    labelSmall = baseTypography.labelSmall.copy(fontSize = 11.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
)

/** Dialog titles sit between titleLarge and titleMedium so long questions wrap cleanly. */
val Typography.dialogTitle: TextStyle get() = titleMedium.copy(fontSize = 18.sp, lineHeight = 26.sp)

/** Tabular numerals keep times and distances aligned in columns. */
val TextStyle.tabular: TextStyle get() = copy(fontFeatureSettings = "tnum")

val RemoShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

private fun remoColorScheme(dark: Boolean) = (if (dark) darkColorScheme() else lightColorScheme()).copy(
    primary = AppColors.green,
    onPrimary = AppColors.onGreen,
    primaryContainer = AppColors.greenContainer,
    onPrimaryContainer = AppColors.onGreenContainer,
    inversePrimary = AppColors.mint,
    secondary = AppColors.teal,
    onSecondary = if (dark) Color(0xFF06302A) else Color.White,
    secondaryContainer = AppColors.greenContainer,
    onSecondaryContainer = AppColors.onGreenContainer,
    tertiary = AppColors.amber,
    onTertiary = if (dark) Color(0xFF3D2708) else Color.White,
    tertiaryContainer = AppColors.amberContainer,
    onTertiaryContainer = if (dark) Color(0xFFF5EADB) else Color(0xFF3D2708),
    background = AppColors.background,
    onBackground = AppColors.ink,
    surface = AppColors.surface,
    onSurface = AppColors.ink,
    surfaceVariant = AppColors.surfaceMuted,
    onSurfaceVariant = AppColors.inkSecondary,
    surfaceTint = AppColors.green,
    inverseSurface = if (dark) Color(0xFFE6ECE7) else Color(0xFF14291F),
    inverseOnSurface = if (dark) Color(0xFF14291F) else AppColors.onNight,
    error = AppColors.danger,
    onError = if (dark) Color(0xFF601410) else Color.White,
    errorContainer = AppColors.dangerContainer,
    onErrorContainer = if (dark) Color(0xFFFBEAE8) else Color(0xFF410E0B),
    outline = AppColors.outlineStrong,
    outlineVariant = AppColors.outline,
    scrim = Color.Black,
    surfaceBright = AppColors.surface,
    surfaceDim = if (dark) Color(0xFF0B100E) else Color(0xFFE3E7E1),
    surfaceContainerLowest = AppColors.surface,
    surfaceContainerLow = AppColors.surface,
    surfaceContainer = AppColors.surface,
    surfaceContainerHigh = AppColors.surface,
    surfaceContainerHighest = AppColors.surfaceMuted,
)

@Composable
fun RemoTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    // Set before the first frame reads a color, and again when the system setting changes.
    if (AppColors.dark != dark) AppColors.dark = dark
    MaterialTheme(colorScheme = remoColorScheme(dark), typography = RemoTypography, shapes = RemoShapes, content = content)
}

/** Switches status bar icons while this composable is shown, e.g. over a dark hero or a photo. */
@Composable
internal fun StatusBarIcons(darkIcons: Boolean) {
    val view = LocalView.current
    if (view.isInEditMode) return
    DisposableEffect(view, darkIcons) {
        val window = (view.parent as? DialogWindowProvider)?.window ?: (view.context as? Activity)?.window
        if (window == null) return@DisposableEffect onDispose { }
        val controller = WindowCompat.getInsetsController(window, view)
        val previous = controller.isAppearanceLightStatusBars
        controller.isAppearanceLightStatusBars = darkIcons
        onDispose { controller.isAppearanceLightStatusBars = previous }
    }
}
