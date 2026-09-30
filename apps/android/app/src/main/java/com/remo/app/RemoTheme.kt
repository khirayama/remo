package com.remo.app

import android.app.Activity
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
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
    val background = Color(0xFFF4F5F1)
    val surface = Color(0xFFFFFFFF)
    val surfaceMuted = Color(0xFFF0F2EE)
    val outline = Color(0xFFE2E7E1)
    val outlineStrong = Color(0xFFC9D2C9)

    val ink = Color(0xFF14291F)
    val inkSecondary = Color(0xFF55635A)
    val inkTertiary = Color(0xFF7E8A82)

    val green = Color(0xFF2F5A45)
    val greenContainer = Color(0xFFDFECE2)
    val onGreenContainer = Color(0xFF16352A)
    val mint = Color(0xFF1FCFA8)

    val teal = Color(0xFF0E8577)
    val tealContainer = Color(0xFFD9F0EB)
    val amber = Color(0xFF9E6A2C)
    val amberContainer = Color(0xFFF5EADB)

    val danger = Color(0xFFB3261E)
    val dangerContainer = Color(0xFFFBEAE8)

    val night = Color(0xFF10261D)
    val onNight = Color(0xFFF2F5F0)
    val onNightMuted = Color(0xB3F2F5F0)
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

private val RemoColorScheme = lightColorScheme(
    primary = AppColors.green,
    onPrimary = Color.White,
    primaryContainer = AppColors.greenContainer,
    onPrimaryContainer = AppColors.onGreenContainer,
    inversePrimary = AppColors.mint,
    secondary = AppColors.teal,
    onSecondary = Color.White,
    secondaryContainer = AppColors.greenContainer,
    onSecondaryContainer = AppColors.onGreenContainer,
    tertiary = AppColors.amber,
    onTertiary = Color.White,
    tertiaryContainer = AppColors.amberContainer,
    onTertiaryContainer = Color(0xFF3D2708),
    background = AppColors.background,
    onBackground = AppColors.ink,
    surface = AppColors.surface,
    onSurface = AppColors.ink,
    surfaceVariant = AppColors.surfaceMuted,
    onSurfaceVariant = AppColors.inkSecondary,
    surfaceTint = AppColors.green,
    inverseSurface = AppColors.ink,
    inverseOnSurface = AppColors.onNight,
    error = AppColors.danger,
    onError = Color.White,
    errorContainer = AppColors.dangerContainer,
    onErrorContainer = Color(0xFF410E0B),
    outline = AppColors.outlineStrong,
    outlineVariant = AppColors.outline,
    scrim = Color.Black,
    surfaceBright = AppColors.surface,
    surfaceDim = Color(0xFFE3E7E1),
    surfaceContainerLowest = AppColors.surface,
    surfaceContainerLow = AppColors.surface,
    surfaceContainer = AppColors.surface,
    surfaceContainerHigh = AppColors.surface,
    surfaceContainerHighest = AppColors.surfaceMuted,
)

@Composable
fun RemoTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = RemoColorScheme, typography = RemoTypography, shapes = RemoShapes, content = content)
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
