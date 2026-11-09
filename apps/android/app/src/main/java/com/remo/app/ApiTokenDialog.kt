package com.remo.app

import android.content.ClipData
import android.content.ClipDescription
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val MAX_TOKEN_NAME_LENGTH = 50

/** The message for a failed token request, or null when the session has ended (handled by the caller). */
private fun tokenErrorMessage(error: Throwable, action: String): String? = when {
    isSessionRejected(error) -> null
    (error as? ApiException)?.code == "token_limit" -> "発行できるトークンの上限に達しています。不要なトークンを削除してください"
    else -> "トークンを${action}できませんでした。通信環境を確認してください"
}

/**
 * Issues and revokes tokens for AI tools (MCP). A new token is shown once,
 * with setup snippets for common tools; it cannot be shown again. Matches the
 * web app's ApiTokenDialog.
 */
@Composable
internal fun ApiTokenDialog(onDismiss: () -> Unit, onSessionExpired: () -> Unit) {
    val scope = rememberCoroutineScope()
    var tokens by remember { mutableStateOf<List<ApiToken>?>(null) }
    var name by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var created by remember { mutableStateOf<CreatedApiToken?>(null) }

    suspend fun perform(action: String, block: suspend () -> Unit) {
        busy = true
        error = null
        try {
            block()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            val message = tokenErrorMessage(failure, action)
            if (message == null) onSessionExpired() else error = message
        } finally {
            busy = false
        }
    }

    LaunchedEffect(Unit) { perform("読み込め") { tokens = ApiClient.listApiTokens() } }

    created?.let { issued ->
        IssuedTokenDialog(issued) { created = null }
        return
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        icon = { Icon(Icons.Outlined.Key, null, tint = AppColors.inkSecondary) },
        title = { Text("AIツールとの接続（MCP）", textAlign = TextAlign.Center, style = MaterialTheme.typography.dialogTitle) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "Claude などのAIツールから、クラウドにバックアップした滞在・移動・場所名を読み取れるようにします。このアプリでは読み取り専用のトークンだけを発行します。トークンを知っている人は記録を読めるため、他人に共有しないでください。不要になったら削除してください。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = AppColors.inkSecondary,
                )
                fun issue() {
                    scope.launch {
                        perform("発行") {
                            val result = ApiClient.createApiToken(name.trim())
                            tokens = listOf(result.token) + tokens.orEmpty()
                            name = ""
                            created = result
                        }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it.take(MAX_TOKEN_NAME_LENGTH) },
                        label = { Text("名前（任意）") },
                        singleLine = true,
                        enabled = !busy,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { if (!busy && tokens != null) issue() }),
                        modifier = Modifier.weight(1f),
                    )
                    Button(onClick = ::issue, enabled = !busy && tokens != null) { Text("発行") }
                }
                error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = AppColors.danger) }
                val current = tokens
                when {
                    current == null -> if (error == null) {
                        CircularProgressIndicator(Modifier.size(20.dp).align(Alignment.CenterHorizontally), color = AppColors.green, strokeWidth = 2.dp)
                    }
                    current.isEmpty() -> Text("発行済みのトークンはありません。", style = MaterialTheme.typography.bodyMedium, color = AppColors.inkSecondary)
                    else -> Column {
                        current.forEach { token ->
                            HorizontalDivider(color = AppColors.outline)
                            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(token.name.ifBlank { "名前なし" }, style = MaterialTheme.typography.bodyLarge, color = AppColors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        if (token.canWrite) {
                                            Text(
                                                "編集可",
                                                style = MaterialTheme.typography.labelSmall,
                                                color = AppColors.onGreenContainer,
                                                modifier = Modifier.padding(start = 6.dp)
                                                    .background(AppColors.greenContainer, MaterialTheme.shapes.small)
                                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                                            )
                                        }
                                    }
                                    Text("${formatDate(dayKey(token.createdAt))}に発行", style = MaterialTheme.typography.bodySmall, color = AppColors.inkTertiary)
                                }
                                IconButton(enabled = !busy, onClick = {
                                    scope.launch {
                                        perform("削除") {
                                            ApiClient.deleteApiToken(token.id)
                                            tokens = tokens?.filterNot { it.id == token.id }
                                        }
                                    }
                                }) { Icon(Icons.Outlined.DeleteOutline, "${token.name.ifBlank { "名前なし" }}のトークンを削除", tint = AppColors.inkSecondary) }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("閉じる") } },
    )
}

@Composable
private fun IssuedTokenDialog(issued: CreatedApiToken, onDone: () -> Unit) {
    var expanded by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        // Closing by accident would lose the token, so only the button closes it.
        onDismissRequest = {},
        icon = { Icon(Icons.Outlined.Key, null, tint = AppColors.inkSecondary) },
        title = { Text("トークンを発行しました", textAlign = TextAlign.Center, style = MaterialTheme.typography.dialogTitle) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("このトークンは今だけ表示されます。閉じると再表示できないため、AIツールに設定してから閉じてください。", style = MaterialTheme.typography.bodyMedium, color = AppColors.inkSecondary)
                CopyableValue(issued.plainToken, "トークン", sensitive = true)
                CopyableValue(mcpEndpointUrl, "接続先URL", sensitive = false)
                Text("AIツールの設定例", style = MaterialTheme.typography.titleSmall, color = AppColors.ink)
                Column {
                    buildMcpClientExamples(mcpEndpointUrl, issued.plainToken).forEach { example ->
                        val open = expanded == example.name
                        HorizontalDivider(color = AppColors.outline)
                        Row(
                            Modifier.fillMaxWidth().clickable { expanded = if (open) null else example.name }.padding(vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(example.name, style = MaterialTheme.typography.bodyLarge, color = AppColors.ink)
                            Text(example.location, style = MaterialTheme.typography.bodySmall, color = AppColors.inkTertiary, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, tint = AppColors.inkTertiary, modifier = Modifier.size(20.dp))
                        }
                        if (open) {
                            Text(
                                example.snippet,
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                color = AppColors.ink,
                                softWrap = false,
                                modifier = Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).background(AppColors.surfaceMuted)
                                    .horizontalScroll(rememberScrollState()).padding(12.dp),
                            )
                            CopyButton(example.snippet, "${example.name}の設定", sensitive = true)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDone) { Text("完了") } },
    )
}

@Composable
private fun CopyableValue(value: String, label: String, sensitive: Boolean) {
    Row(
        Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).background(AppColors.surfaceMuted).padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(value, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = AppColors.ink, modifier = Modifier.weight(1f).padding(vertical = 8.dp))
        CopyButton(value, label, sensitive)
    }
}

@Composable
private fun CopyButton(text: String, label: String, sensitive: Boolean) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    TextButton(onClick = {
        scope.launch {
            val clip = ClipData.newPlainText(label, text)
            // Keeps the token out of the clipboard preview on Android 13+.
            if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
            }
            clipboard.setClipEntry(ClipEntry(clip))
            copied = true
            delay(1_500)
            copied = false
        }
    }) {
        Icon(Icons.Outlined.ContentCopy, null, modifier = Modifier.size(18.dp))
        Text(if (copied) "コピーしました" else "コピー", modifier = Modifier.padding(start = 4.dp))
    }
}
