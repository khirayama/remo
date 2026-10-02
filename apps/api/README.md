# Remo API

Cloudflare Workers + D1で認証とTimeline recordの同期を提供します。recordはユーザーIDで分離され、クライアント生成IDによるlocal-first同期に対応します。

APIは時刻・緯度経度・写真枚数・取得元と、写真位置の補正メタデータをD1へ保存します。ログインした端末から160 KB以下の再圧縮JPEGを受け取り、非公開R2バケットへ保存します。元写真と動画本体は受信しません。補正時は元のEXIF座標も保持し、元のEXIFへ戻した写真の自動表示配置を無効化する状態も同期します。

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

## Endpoints

- `GET /api/v1/health`
- `GET /api/v1/me`（認証必須）
- `GET /api/v1/events/head`（ユーザーの同期連番だけを読む軽量な同期前チェック）
- `GET /api/v1/events`（カーソルなしは全件。写真記録・削除記録→位置チャンクの順に主キーでページングし、`meta.nextPage` を次の `?page=` に渡して続きを取得する。最後の `meta.cursor` を以後の `?cursor=` に使う。`?cursor=` 指定時はそれ以降の差分を返し、続きがあれば `meta.nextCursorToken` を返す。`meta.deletions` は他の端末で1件ずつ削除された記録（`id` と `deletedAt`）で、受け取った端末は自分のコピーも削除する）
- `POST /api/v1/events/batch`（`events` の作成・更新と `deletions` の削除を合計最大500件まで一括処理。`deletions` は `startedAt`・`source` を添えると保存先を検索せずに済む。不正な項目があっても他の項目は処理し、不正な項目は `data.rejected` で返すので、1件の不正データで端末の送信キューが止まらない。リクエスト全体の形式が不正な場合だけ400。同じ時間帯への同時書き込みに負け続けた場合は503を返し、クライアントは同じbatchを再送する）
- `DELETE /api/v1/data`（認証ユーザーの全recordを物理削除）
- `GET /api/v1/places` / `PUT /api/v1/places`（ユーザーが付けた場所名。新しい`updatedAt`が勝つ）
- `GET /api/v1/photos/:eventId`（写真イベントのサムネイルID一覧。D1の `photo_preview` から読む）
- `GET /api/v1/photos/:eventId/:digest`（認証済みユーザーのJPEGを取得）
- `PUT /api/v1/photos/:eventId/:digest`（160 KB以下のJPEGを保存。digestはSHA-256）
- `PUT /api/v1/photos/:eventId`（`{ digests }`: その記録に今も含まれるプレビューの一覧。一覧にないプレビューを削除する）
- `/api/auth/*`（Better AuthのEmail/Password認証）

同期時はrecordの`updatedAt`（端末時計）で競合を解決し、古い更新で新しい内容を上書きしません。削除の`deletedAt`も同じ端末時計で比較するため、削除と他端末の編集は新しい方が勝ちます。時計が進んだ端末が以後の競合で勝ち続けないよう、`updatedAt`・`deletedAt`はサーバー時刻+5分を上限にします。`startedAt`は1900年以降かつサーバー時刻+1日以内だけ受け付けます。

Cookie認証（Web）の書き込みは、`CORS_ALLOWED_ORIGINS` に含まれる `Origin` と `Content-Type: application/json`（JSON本文のエンドポイント）を必須にします。Bearerトークン（ネイティブアプリ）は対象外です。本番のWebはWeb側Workerの `/api/*` プロキシ経由で同一オリジンから呼び出すため、セッションCookieは `SameSite=Lax` です。デプロイ時は、Web（プロキシ）を先に、APIを後に反映してください。`CORS_ALLOWED_ORIGINS` と `BETTER_AUTH_TRUSTED_ORIGINS` には、このプロジェクトが実際に配信しているオリジンだけを書いてください（Better Authはパスワード再設定のリンクを信頼済みオリジンへリダイレクトします）。

R2には`remo-photo-previews-dev`と`remo-photo-previews`のプライベートバケットを使います。レコード削除・全データ削除・アカウント削除では画像を直ちに参照不可にし、毎時のCronがR2オブジェクトを順次削除します（1回あたり100件の削除予約。削除予約は写真レコードの削除時だけ作ります）。元写真の復元には利用できません。

## 保存形式とD1の読み書きコスト

位置サンプルは `location_chunk`（ユーザーごと・6時間ごとに1行、サンプルはJSON配列）に、写真記録と削除記録は `life_event`（1記録1行）に保存します。位置サンプルは1日に千〜数千件増えますが変更されないため、1件1行で持つと、復元のたびに全行を読み、1件の書き込みごとに2行を書くことになります。チャンクにすると次のようになります。

- 端末からの1リクエスト（最大500件）は、通常1〜2チャンクの読み書き（＋連番の1行）で済みます。内容が変わらない再送は読み取りだけで、書き込みません。
- 全件の復元は、位置について1日あたり4行を読みます。
- 差分同期は `(user_id, updated_at)` インデックスの範囲読みで、変更されたチャンクだけを読み、そのうちカーソル以降に書かれたサンプルだけを返します。
- 「すべて削除」は行の物理削除で、行ごとの書き換えはしません。

書き込む行はすべて `user_sync_state.seq`（ユーザー単位の連番）から `updated_at` を取ります。連番は書き込みと同じトランザクション内でD1の時計から採番し、必ず増えるので、同じミリ秒の書き込みや時計の逆行があっても差分同期で取りこぼしません。同じチャンクへの同時書き込みは「読んだ版のままなら書く」条件付き更新で検出し、負けた側が読み直してマージし直します。

そのほか:

- `life_event` は `PRIMARY KEY (user_id, id)` の `WITHOUT ROWID` テーブルです。内容が同じレコードのアップサートは書き込みを行いません。
- 認証は署名付き `session_data` cookie（5分）で session/user の読み取りを省略します。
- 写真のサムネイルID一覧は `photo_preview(user_id, event_id, digest)` の範囲読みです。R2のlistは、テーブル導入前の画像を初回に登録するときだけ使います。
- 期限切れのsession/verificationの削除は `expires_at` インデックスを使います。

### 上限とレート制限

| 対象 | 上限 |
| --- | --- |
| 認証系のPOST（IPごと） | 60秒10回 |
| ログイン後の書き込み（アカウントごと） | 60秒600回 |
| 位置チャンク1行 | 1.5 MB（超える分のサンプルは `rejected`） |
| 位置チャンク数（アカウントごと） | 40,000（約27年分） |
| プレビュー | 1記録1,000枚、1アカウント100,000枚 |
| 場所名 | 2,000件 |

`REQUIRE_EMAIL_VERIFICATION=true` を設定すると、メールアドレスを確認するまでログインできなくなります（確認メールの送信に `RESEND_API_KEY` と `MAIL_FROM` が必要。`WEB_APP_URL` は確認後の戻り先）。有効にすると既存のアカウントも次回ログイン時に確認が必要になるため、既定はオフです。

## 運用

- **デプロイ**: `npm run deploy:production`（または `just api-deploy`）は、未適用のD1マイグレーションを本番DBへ適用してからWorkerをデプロイします。マイグレーションだけを先に適用する場合は `npm run db:migrate:remote`。
- **テーブルを作り直すマイグレーションの前**（`0019_location_chunks.sql` など）は、`just api-backup` で本番DBをSQLに書き出しておいてください。D1のTime Travel（30日）でも復元できます。`0019` は位置の行をチャンクへコピーし、`life_event` を残す行だけで作り直して旧テーブルを破棄します（行ごとの削除はしないので、書き込み行数は位置の行数に比例しません）。
- **新旧クライアントの混在**: APIの形は旧クライアントとも互換ですが、旧クライアントは「すべて削除」の後に全件同期（カーソルが無い状態でのログイン）をすると、端末に残っている古い記録を再アップロードします。3クライアントを更新してからAPIをデプロイするのが安全です。
- **ログ**: 未処理の例外とCronの失敗は1行のJSON（`level`, `event`, `message`）で出力します。Workers Logs（`observability.enabled`）で `level:"error"` を条件に通知を設定してください。
- **ステージング**: `wrangler.jsonc` には `development`（ローカル）と `production` だけがあります。本番データを使わずに確認したい場合は、D1・R2・レート制限のnamespaceを別に作り、`env.staging` を追加してください。
