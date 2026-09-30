package com.remo.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.CloudDone
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.FileOpen
import androidx.compose.material.icons.outlined.IosShare
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.PersonRemove
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import kotlinx.coroutines.launch

internal data class SettingsState(
    val autoCapture: Boolean,
    val photoAccess: Boolean,
    val photoLocationAccess: Boolean,
    val syncStatus: String,
    val lastBackupAt: Long?,
    val user: RemoUser?,
)

internal class SettingsActions(
    val onBack: () -> Unit,
    val onCapture: () -> Unit,
    val onPhotos: () -> Unit,
    val onExport: () -> Unit,
    val onImport: () -> Unit,
    val onDeleteAll: () -> Unit,
    val onBackup: () -> Unit,
    val onOpenAuth: () -> Unit,
    val onSignOut: () -> Unit,
    val onDeleteAccount: () -> Unit,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsScreen(state: SettingsState, actions: SettingsActions) {
    Scaffold(
        containerColor = AppColors.background,
        topBar = {
            TopAppBar(
                title = { Text("設定", style = MaterialTheme.typography.titleLarge) },
                navigationIcon = { IconButton(onClick = actions.onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "戻る") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = AppColors.background, scrolledContainerColor = AppColors.background),
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 32.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            item {
                SettingsGroup("記録") {
                    ActionRow(
                        Icons.Outlined.LocationOn,
                        "位置情報の記録",
                        subtitle = if (state.autoCapture) "移動中は10秒、静止時は5分ごとに記録" else "停止中",
                        trailing = {
                            Switch(
                                checked = state.autoCapture,
                                onCheckedChange = { actions.onCapture() },
                                colors = SwitchDefaults.colors(checkedTrackColor = AppColors.green, uncheckedTrackColor = AppColors.surfaceMuted),
                            )
                        },
                        onClick = actions.onCapture,
                    )
                    GroupDivider()
                    val photosReady = state.photoAccess && state.photoLocationAccess
                    ActionRow(
                        Icons.Outlined.PhotoLibrary,
                        "写真と動画",
                        subtitle = when {
                            !state.photoAccess -> "撮影日時と位置をタイムラインに表示するには許可が必要です"
                            !state.photoLocationAccess -> "写真の位置情報へのアクセスを許可してください"
                            else -> "撮影日時と位置を読み込んでいます"
                        },
                        trailing = { TrailingLabel(if (photosReady) "許可済み" else "許可する", emphasized = !photosReady) },
                        onClick = actions.onPhotos,
                    )
                }
            }
            item {
                if (state.user == null) BackupSignInCard(actions.onOpenAuth) else SettingsGroup("バックアップ") {
                    val backedUp = state.lastBackupAt != null
                    ActionRow(
                        if (backedUp) Icons.Outlined.CloudDone else Icons.Outlined.CloudUpload,
                        state.syncStatus,
                        subtitle = state.lastBackupAt?.let { "最終バックアップ ${formatBackupTime(it)}" } ?: "まだバックアップされていません",
                        trailing = { TextButton(onClick = actions.onBackup) { Text("今すぐ") } },
                        onClick = null,
                    )
                    GroupDivider()
                    ActionRow(Icons.Outlined.Person, state.user.email, subtitle = "ログイン中", onClick = null)
                    GroupDivider()
                    ActionRow(Icons.AutoMirrored.Outlined.Logout, "ログアウト", onClick = actions.onSignOut)
                }
            }
            item {
                SettingsGroup("データ") {
                    ActionRow(Icons.Outlined.IosShare, "JSONをエクスポート", subtitle = "期間を指定して位置と写真の情報を書き出します", trailing = { Chevron() }, onClick = actions.onExport)
                    GroupDivider()
                    ActionRow(Icons.Outlined.FileOpen, "JSONをインポート", subtitle = "書き出したファイルから記録を読み込みます", trailing = { Chevron() }, onClick = actions.onImport)
                }
            }
            item {
                SettingsGroup("削除") {
                    ActionRow(Icons.Outlined.DeleteOutline, "すべての記録を削除", tint = AppColors.danger, onClick = actions.onDeleteAll)
                    if (state.user != null) {
                        GroupDivider()
                        ActionRow(Icons.Outlined.PersonRemove, "アカウントを削除", tint = AppColors.danger, onClick = actions.onDeleteAccount)
                    }
                }
            }
            item {
                Text(
                    "Remo ${BuildConfig.VERSION_NAME}\n記録は端末に保存され、写真は外部に送信されません",
                    style = MaterialTheme.typography.bodySmall,
                    color = AppColors.inkTertiary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column {
        SectionLabel(title, Modifier.padding(start = 4.dp, bottom = 8.dp))
        Surface(shape = MaterialTheme.shapes.large, color = AppColors.surface) {
            Column(content = content)
        }
    }
}

@Composable
private fun GroupDivider() = HorizontalDivider(Modifier.padding(start = 56.dp), color = AppColors.outline)

@Composable
private fun Chevron() = Icon(Icons.Outlined.ChevronRight, null, tint = AppColors.inkTertiary, modifier = Modifier.size(20.dp))

@Composable
private fun TrailingLabel(text: String, emphasized: Boolean) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = if (emphasized) AppColors.green else AppColors.inkTertiary)
}

@Composable
private fun BackupSignInCard(onOpenAuth: () -> Unit) {
    Column {
        SectionLabel("バックアップ", Modifier.padding(start = 4.dp, bottom = 8.dp))
        Surface(shape = MaterialTheme.shapes.large, color = AppColors.surface) {
            Column(Modifier.padding(16.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Icon(Icons.Outlined.CloudUpload, null, tint = AppColors.green, modifier = Modifier.size(24.dp))
                    Column(Modifier.weight(1f)) {
                        Text("クラウドにバックアップ", style = MaterialTheme.typography.titleSmall, color = AppColors.ink)
                        Text("ログインすると記録と写真の縮小画像をバックアップします。元写真と動画本体は含まれません。", style = MaterialTheme.typography.bodySmall, color = AppColors.inkSecondary, modifier = Modifier.padding(top = 2.dp))
                    }
                }
                Button(onClick = onOpenAuth, modifier = Modifier.fillMaxWidth().padding(top = 16.dp).height(48.dp)) { Text("ログイン・新規登録") }
            }
        }
    }
}

@Composable
internal fun AccountDeletionDialog(onDismiss: () -> Unit, onDelete: suspend (String) -> String?) {
    val scope = rememberCoroutineScope()
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!deleting) onDismiss() },
        icon = { Icon(Icons.Outlined.PersonRemove, null, tint = AppColors.danger) },
        title = { Text("アカウントを削除しますか？", textAlign = TextAlign.Center, style = MaterialTheme.typography.dialogTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("アカウントとクラウドのバックアップを削除します。この操作は元に戻せません。この端末の記録は残ります。", style = MaterialTheme.typography.bodyMedium, color = AppColors.inkSecondary)
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it; error = null },
                    label = { Text("パスワード") },
                    singleLine = true,
                    enabled = !deleting,
                    isError = error != null,
                    supportingText = error?.let { { Text(it) } },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = password.isNotEmpty() && !deleting,
                onClick = {
                    deleting = true
                    scope.launch {
                        error = onDelete(password)
                        deleting = false
                    }
                },
            ) { Text(if (deleting) "削除中…" else "削除する", color = if (password.isNotEmpty() && !deleting) AppColors.danger else AppColors.inkTertiary) }
        },
        dismissButton = { TextButton(enabled = !deleting, onClick = onDismiss) { Text("キャンセル") } },
    )
}

@Composable
internal fun ExportRangeDialog(
    startDate: String,
    endDate: String,
    locationCount: Int,
    photoCount: Int,
    onStartDateChange: (String) -> Unit,
    onEndDateChange: (String) -> Unit,
    onDismiss: () -> Unit,
    onExport: () -> Unit,
) {
    var editing by remember { mutableStateOf<String?>(null) }
    val invalid = startDate > endDate
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("JSONをエクスポート", style = MaterialTheme.typography.dialogTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                DateField("開始日", startDate) { editing = "start" }
                DateField("終了日", endDate) { editing = "end" }
                Text(
                    if (invalid) "終了日は開始日以降にしてください" else "位置 ${locationCount}件 · 写真と動画 ${photoCount}件",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (invalid) AppColors.danger else AppColors.inkSecondary,
                    modifier = Modifier.padding(top = 4.dp, start = 4.dp),
                )
            }
        },
        confirmButton = { TextButton(onClick = onExport, enabled = !invalid) { Text("書き出す") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
    editing?.let { field ->
        RemoDatePickerDialog(if (field == "start") startDate else endDate, onDismiss = { editing = null }) {
            if (field == "start") onStartDateChange(it) else onEndDateChange(it)
            editing = null
        }
    }
}

@Composable
private fun DateField(label: String, value: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).background(AppColors.surfaceMuted).clickable(onClickLabel = "${label}を変更", onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = AppColors.inkSecondary)
            Text(formatDate(value), style = MaterialTheme.typography.bodyLarge, color = AppColors.ink)
        }
        Icon(Icons.Outlined.CalendarMonth, null, tint = AppColors.inkSecondary, modifier = Modifier.size(20.dp))
    }
}
