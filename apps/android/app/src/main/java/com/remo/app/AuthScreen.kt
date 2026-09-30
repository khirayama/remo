package com.remo.app

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AuthScreen(state: AuthUiState, viewModel: AuthViewModel, onCancel: () -> Unit) {
    var showPassword by remember { mutableStateOf(false) }
    BackHandler(onBack = onCancel)
    StatusBarIcons(darkIcons = false)
    Box(Modifier.fillMaxSize().background(AppColors.night)) {
        Column(
            Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            Row(Modifier.fillMaxWidth().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onCancel, modifier = Modifier.offset(x = (-12).dp)) {
                    Icon(Icons.Outlined.Close, "閉じる", tint = AppColors.onNight)
                }
            }
            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(40.dp).background(AppColors.surface, MaterialTheme.shapes.medium), contentAlignment = Alignment.Center) {
                    Image(painterResource(R.drawable.ic_launcher_foreground), null, Modifier.requiredSize(64.dp))
                }
                Text("remo", style = MaterialTheme.typography.headlineSmall, color = AppColors.onNight)
            }
            Text(
                "毎日を、静かに。\n自分のために。",
                style = MaterialTheme.typography.displaySmall,
                color = AppColors.onNight,
                modifier = Modifier.padding(top = 24.dp),
            )
            Text(
                "位置と写真を1日の地図にまとめて、あとから眺められます。ログインすると記録がバックアップされ、Webや他の端末でも見られます。",
                style = MaterialTheme.typography.bodyMedium,
                color = AppColors.onNightMuted,
                modifier = Modifier.padding(top = 12.dp),
            )
            Surface(Modifier.fillMaxWidth().padding(top = 24.dp), shape = MaterialTheme.shapes.extraLarge, color = AppColors.surface) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        listOf(false to "ログイン", true to "新規登録").forEachIndexed { index, (signUp, label) ->
                            SegmentedButton(
                                selected = state.signUp == signUp,
                                onClick = { if (state.signUp != signUp) viewModel.toggleMode() },
                                shape = SegmentedButtonDefaults.itemShape(index, 2),
                                icon = {},
                                colors = SegmentedButtonDefaults.colors(activeContainerColor = AppColors.greenContainer, activeContentColor = AppColors.onGreenContainer, inactiveContentColor = AppColors.inkSecondary),
                            ) { Text(label) }
                        }
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(if (state.signUp) "はじめましょう" else "おかえりなさい", style = MaterialTheme.typography.headlineSmall, color = AppColors.ink)
                        Text(
                            if (state.signUp) "メールアドレスとパスワードで登録します。" else "登録したメールアドレスでログインします。",
                            style = MaterialTheme.typography.bodyMedium,
                            color = AppColors.inkSecondary,
                        )
                    }
                    OutlinedTextField(
                        value = state.email,
                        onValueChange = viewModel::setEmail,
                        label = { Text("メールアドレス") },
                        leadingIcon = { Icon(Icons.Outlined.Email, null) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                        shape = MaterialTheme.shapes.medium,
                        colors = authFieldColors(),
                        modifier = Modifier.fillMaxWidth().semantics {
                            contentType = if (state.signUp) ContentType.NewUsername + ContentType.EmailAddress else ContentType.Username + ContentType.EmailAddress
                        },
                    )
                    OutlinedTextField(
                        value = state.password,
                        onValueChange = viewModel::setPassword,
                        label = { Text("パスワード") },
                        leadingIcon = { Icon(Icons.Outlined.Lock, null) },
                        trailingIcon = {
                            IconButton(onClick = { showPassword = !showPassword }) {
                                Icon(if (showPassword) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (showPassword) "パスワードを隠す" else "パスワードを表示")
                            }
                        },
                        supportingText = if (state.signUp) ({ Text("8文字以上") }) else null,
                        singleLine = true,
                        visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { viewModel.submit() }),
                        shape = MaterialTheme.shapes.medium,
                        colors = authFieldColors(),
                        modifier = Modifier.fillMaxWidth().semantics { contentType = if (state.signUp) ContentType.NewPassword else ContentType.Password },
                    )
                    state.error?.let {
                        Row(
                            Modifier.fillMaxWidth().background(AppColors.dangerContainer, MaterialTheme.shapes.medium).padding(12.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(Icons.Outlined.ErrorOutline, null, tint = AppColors.danger, modifier = Modifier.size(20.dp))
                            Text(it, style = MaterialTheme.typography.bodySmall, color = AppColors.danger, modifier = Modifier.padding(top = 1.dp))
                        }
                    }
                    Button(onClick = viewModel::submit, enabled = !state.isSubmitting, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                        if (state.isSubmitting) CircularProgressIndicator(color = AppColors.surface, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                        else Text(if (state.signUp) "アカウントを作成" else "ログイン")
                    }
                }
            }
            TextButton(onClick = onCancel, modifier = Modifier.align(Alignment.CenterHorizontally).padding(vertical = 16.dp)) {
                Text("ログインせずに使う", color = AppColors.onNightMuted)
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

@Composable
private fun authFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = AppColors.green,
    unfocusedBorderColor = AppColors.outlineStrong,
    focusedContainerColor = AppColors.surface,
    unfocusedContainerColor = AppColors.surface,
    focusedLabelColor = AppColors.green,
    unfocusedLabelColor = AppColors.inkSecondary,
    focusedLeadingIconColor = AppColors.green,
    unfocusedLeadingIconColor = AppColors.inkSecondary,
)
