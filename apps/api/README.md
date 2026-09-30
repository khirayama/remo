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
- `GET /api/v1/events/head`（最新カーソルだけを確認する軽量な同期前チェック）
- `GET /api/v1/events`（カーソルなしは5,000件単位のスナップショット同期。`meta.nextPage` を次の `?page=` に渡して続きを取得し、最後の `meta.cursor` を以後の `?cursor=` に使う。`?cursor=` 指定時はそれ以降の差分を返し、続きがあれば `meta.nextCursorToken` を返す）
- `POST /api/v1/events/batch`（`events` の作成・更新と `deletions` の削除を合計最大40件まで一括処理）
- `DELETE /api/v1/events/:id`（旧ビルド用の単件soft delete）
- `DELETE /api/v1/data`（認証ユーザーの全recordを削除）
- `GET /api/v1/photos/:eventId`（写真イベントのサムネイルID一覧）
- `GET /api/v1/photos/:eventId/:digest`（認証済みユーザーのJPEGを取得）
- `PUT /api/v1/photos/:eventId/:digest`（160 KB以下のJPEGを保存。digestはSHA-256）
- `/api/auth/*`（Better AuthのEmail/Password認証）

同期時はrecordの`updatedAt`（端末時計）で競合を解決し、古い更新で新しい内容を上書きしません。削除の`deletedAt`も同じ端末時計で比較するため、削除と他端末の編集は新しい方が勝ちます。削除済みrecordのIDは同期用メタデータとして返します。

R2には`remo-photo-previews-dev`と`remo-photo-previews`のプライベートバケットを使います。レコード削除・全データ削除・アカウント削除では画像を直ちに参照不可にし、CronがR2オブジェクトを順次削除します。元写真の復元には利用できません。

cursorはサーバー側`updated_at`とrecord IDの複合キーです。`updated_at`はWorkerの時計ではなくD1内で採番するため、Workerごとの時計のずれや送信遅延によって差分同期で取りこぼすことを防ぎます。record IDはユーザー単位で一意です。

## D1の読み書きコスト

D1の rows read/written を抑えるため、次の前提で実装しています。

- 同期の読み取りはすべて `life_event(user_id, updated_at, id)` インデックスの範囲読みで、1回あたり最大5,000行です。上限なしの全件読みや、全件ソートが必要なクエリは置きません。
- `life_event` は `PRIMARY KEY (user_id, id)` の `WITHOUT ROWID` テーブルです。1件の書き込みで更新されるのは本体とsyncインデックスだけです。
- 内容が同じレコードのアップサートは、衝突チェックの読み取り1行だけで書き込みを行いません。
- 認証は署名付き `session_data` cookie（5分）で session/user の読み取りを省略します。
