# 外部 API（MCP）

AI ツールから、クラウドにバックアップした記録を読み取り、補正と場所名を整えるための公開 API。MCP（Model Context Protocol）の Streamable HTTP を 1 つのエンドポイントで提供し、REST API は持たない。MCP は JSON-RPC over HTTP なので、MCP クライアント以外のスクリプトからも同じエンドポイントを呼べる。

## エンドポイント

- 本番は `https://remo-web.just-do-it-my-life.workers.dev/api/mcp`。Web の Worker が `/api/*` を Service Binding で API へ中継するため、Web と同じオリジンで受ける（API の `https://remo-api.just-do-it-my-life.workers.dev/api/mcp` でも同じ）。
- 開発は `just api` の `http://localhost:8787/api/mcp`。Web の設定画面は `apiOrigin`（`VITE_API_BASE_URL`、空なら Web のオリジン）+ `/api/mcp` を表示する。
- 実装は `apps/api/src/lib/mcp.ts`。stateless で、session（`Mcp-Session-Id`）を持たずリクエストごとに MCP server を作る。2025 年版の stateless 接続と 2026-07-28 版の両方を受け付ける。
- `/api/v1/*` の外に置くため、Cookie 認証用の Origin 検査（`guardCookieWrites`）は通らない。Cookie では認証しない。
- `*.workers.dev` には Browser Integrity Check がかかるため、ライブラリ既定の User-Agent（Python urllib など）からの呼び出しは `403` になることがある。独自ドメインへ移すときは `/api/mcp` の Browser Integrity Check を無効にする。

## 認証

- `Authorization: Bearer <token>` だけを受け付ける。OAuth は提供しないため、Bearer token をヘッダーで渡せるクライアント（Claude Code、Cursor など）が対象で、OAuth 前提のリモートコネクタ（claude.ai のカスタムコネクタなど）は使えない。
- トークンは `rm_` + 32 bytes の乱数の base64url（43 文字）。形式が違うトークンは D1 を読まずに `401`（`WWW-Authenticate: Bearer`）を返す。
- 検証は `api_token` の主キー（`token_hash` = SHA-256 の小文字 hex）の読み取り 1 回で `user_id` を解決する。平文はどこにも保存せず、ログにも出さない。
- 権限（`api_token.scope`）は `read`（バックアップ全体の読み取り）と `write`（読み取りに加えて、補正と場所の作成・変更・削除。記録そのものは変えない）。`0021` より前に発行したトークンは `read`。有効期限はなく、失効はトークンの削除だけ。アカウント削除で `ON DELETE CASCADE` により消える。「すべての記録を削除」ではトークンは残る。
- リクエストはユーザーごとに `API_RATE_LIMITER`（60 秒 600 回、キー `mcp:<userId>`）で制限する。

## トークンの発行と失効

- Web / Android / iOS の設定 →「バックアップ」→「AI ツールとの接続（MCP）」から開く（ログイン中のみ。Web と Android はダイアログ、iOS はシート）。
- 発行・一覧・削除は `/api/v1/api-tokens`（`GET` / `POST {name, scope}` / `DELETE /:id`）。`scope` は `read`（既定）か `write`。一覧は各トークンの `scope` を返す。書き込みできるトークンは Web の「場所と補正の編集を許可」から発行し、Android / iOS は一覧に「編集可」と表示する（発行は読み取りのみ）。セッション（Cookie またはネイティブの Bearer セッション）で認証し、API トークン自身ではトークンを管理できない。
- 名前は任意で、前後の空白を除いて 50 文字以内。1 ユーザー 20 個まで（超えると `409 token_limit`）。上限の確認と挿入は 1 文で行い、同時発行でも超えない。
- 平文は発行時の応答で 1 回だけ返す。画面は平文・接続先 URL・AI ツールの設定例（Claude Code / Codex / Cursor / VS Code / Gemini CLI。Web `mcp-clients.ts` / Android `McpClientExamples.kt` / iOS `McpClientExamples.swift`）をコピーできる形で表示し、閉じると再表示できない。
- 表示する接続先は、Web が `apiOrigin` + `/api/mcp`、Android / iOS がビルドの API の URL + `/api/mcp`（Android の Debug ビルドはエミュレーター用の `10.0.2.2` を `localhost` に置き換える）。
- 平文のコピーは、Android 13 以降はクリップボードのプレビューに出さない（`EXTRA_IS_SENSITIVE`）、iOS は端末内だけ・10 分で消える（`localOnly` / `expirationDate`）。
- 設定例は 3 プラットフォームで同じ文字列にする。`fixtures/mcp/client-examples.expected.json` を Web の `mcp-clients.test.ts`（`-u` で再生成）が作り、Android `McpClientExamplesTest` と iOS `McpClientExamplesTests` が照合する。

## クライアントの設定

`<endpoint>` は上記のエンドポイント、`rm_...` は発行したトークン。

Claude Code（ターミナル）:

```sh
claude mcp add --transport http remo <endpoint> --header "Authorization: Bearer rm_..."
```

Codex（`~/.codex/config.toml`。トークンを設定ファイルに残したくない場合は `http_headers` の代わりに `bearer_token_env_var = "REMO_API_TOKEN"`）:

```toml
[mcp_servers.remo]
url = "<endpoint>"
http_headers = { "Authorization" = "Bearer rm_..." }
```

Cursor（`~/.cursor/mcp.json`）:

```json
{
  "mcpServers": {
    "remo": {
      "url": "<endpoint>",
      "headers": { "Authorization": "Bearer rm_..." }
    }
  }
}
```

VS Code（「MCP: Open User Configuration」で開く `mcp.json`）:

```json
{
  "servers": {
    "remo": {
      "type": "http",
      "url": "<endpoint>",
      "headers": { "Authorization": "Bearer rm_..." }
    }
  }
}
```

Gemini CLI:

```sh
gemini mcp add --scope user --transport http --header "Authorization: Bearer rm_..." remo <endpoint>
```

MCP クライアントを使わない呼び出し（initialize は不要。`Accept` に `application/json` と `text/event-stream` の両方が必要）:

```sh
curl -sS <endpoint> \
  -H "Authorization: Bearer $REMO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_timeline","arguments":{"date":"2026-10-01","timeZone":"Asia/Tokyo"}}}'
```

応答は SSE の `data:` 行に JSON-RPC の結果が入り、ツールの結果は `result.content[0].text` に JSON 文字列で入る。エラーは `result.isError: true` と説明文で返す。

## ツール

読み取りのツールはすべてのトークンで使え（`readOnlyHint`）、書き込みのツールは `write` のトークンにだけ `tools/list` で見える。補正と場所の規則は [CORRECTIONS.md](./CORRECTIONS.md)。

| tool | 内容 |
|---|---|
| `get_timeline` | `date`（`yyyy-MM-dd`）と `timeZone`（IANA）の 1 日の滞在・移動を時刻順に返す。滞在は時刻・滞在時間・座標・場所・写真/動画数・補正で作られた印（`corrected`）、移動は時刻・距離・記録なし時間・写真/動画数。その日の位置サンプル数・写真記録数と、その日に掛かる補正も返す。 |
| `list_stays` | `from`〜`to`（両端を含む最大 31 日）の滞在を日ごとに返す。記録のない日は `recorded: false`。`placeId` でその場所の滞在だけに絞れる（統合で消えた場所の id は統合先として扱う）。 |
| `list_places` | 名前を付けた場所（削除済みを除く）。最初の基準点と半径、追加の基準点（`index` 付き）。 |
| `list_corrections` | 期間（最大 31 日）に掛かる補正。`createdBy` は `app` か `ai`。 |
| `suggest_corrections` | 期間（最大 31 日）の補正の候補。日ごとに `exclude`（飛んだ測位）・`join_stay`（同じ場所の滞在が 45 分以内に続く、または 250m 以内）・`not_stay`（5m/s 以上の移動に挟まれた 15 分以下の名前のない滞在）、期間全体で `name_place`（名前のない場所で 3 回以上か合計 3 時間以上）・`add_place_anchor`（名前付きの場所から 300m 以内だが範囲外で 2 回以上）。 |
| `get_location_samples` | 1 つの現地の日の中で最大 3 時間の生の測位（時刻・座標・精度、除外されたか、滞在の中か、線に描く座標が違えばその座標）。 |
| `exclude_location_samples`（write） | 範囲（最大 24 時間）の測位を除外する補正を作る。 |
| `join_stays`（write） | 範囲を 1 つの滞在にする補正を作る。 |
| `mark_not_stay`（write） | 範囲の滞在を移動にする補正を作る。 |
| `delete_correction`（write） | 補正を取り消す。 |
| `save_place`（write） | 場所を作る（名前・座標）、または名前・座標・半径を変える。 |
| `add_place_anchor` / `remove_place_anchor`（write） | 基準点を足す・外す（最大 20）。 |
| `merge_places`（write） | 元の場所の全基準点を統合先へ移し、元の場所を削除する（`mergedInto`）。 |
| `delete_place`（write） | 場所を削除する。 |

- 滞在・移動は Web の Timeline と同じ `buildTimelineSnapshot`（`apps/web/src/timeline-map.ts`）に、その日の補正と場所を渡して求める。API は `@remo/timeline-map` という別名で読み込み（`wrangler.jsonc` と `vitest.config.ts` の `alias`）、型は `apps/api/src/types/timeline-map.d.ts` の宣言で検査する（Web のソースは DOM 前提・`noUncheckedIndexedAccess` なしのため）。`timeline-map.ts` は `day.ts` と型以外を import しない。返す形を変えたときは宣言も揃える。
- 1 日は `timeZone` の現地 0 時から翌日 0 時まで（DST を考慮）。返す時刻は現地時刻のオフセット付き ISO 8601（秒単位）。書き込みのツールの時刻もオフセット付き ISO 8601 で受け取る。日付・タイムゾーン・時刻は入力検証で拒否する。
- 場所は、滞在の座標がどれかの基準点の半径に入る場所のうち最も近い基準点の場所（アプリの表示と同じ）。
- 補正の書き込みは `source: "mcp"` で保存し、応答に影響した日の Timeline を含める。アプリは補正を同期し、「この日の補正」に「AI」と表示して取り消せる。場所の書き込みは端末の時計より新しい `updatedAt` で保存する（端末の時計が進んでいても上書きされる）。
- 読むのはクラウドのバックアップだけ。未ログインで端末に残っている記録、写真の縮小画像、元写真は返さない。
- initialize の `instructions` で、Remo が利用者の位置・写真の記録であること（日本語の言い回しを含む）、相対日付と IANA タイムゾーンをクライアント側で解決すること、座標が個人の位置情報であることを伝える。`write` のトークンには、補正は記録を変えず取り消せること、候補を確かめてから適用し、大きな変更や場所の統合・削除の前には利用者に確認することも伝える。

## 1 リクエストあたりの D1 操作

- 認証: 読み取り 1 回。
- `get_timeline`: 位置チャンク（6 時間ごと）約 5 行と写真記録の範囲読み取り、場所名の全件読み取り、補正の範囲読み取り（`started_at` のインデックス）。
- `list_stays` / `suggest_corrections`: 補正は期間分を 1 回で読み、記録は 1 日ずつ順に読む。日をまたぐチャンクは 1 回だけ読み、不要になったら捨てるため、メモリはおよそ 1 日分。
- `life_event` には時刻のインデックスがないため、写真記録はユーザーの写真記録を走査して絞る（件数が少ない前提）。

## 開発中の確認

- `cd apps/api && npx vitest run test/mcp.test.ts` で、`fixtures/timeline` のサンプルを使ったツールの結果（Web のゴールデンと同じ滞在・移動になること）、トークンの発行・上限・失効、他ユーザーの記録が読めないことを確かめる。
- `just api` と `just web` を起動し、Web でログインして設定からトークンを発行すると、ローカル URL の設定例が表示される。

## 配信

- マイグレーション `0020_api_token.sql`・`0021_timeline_corrections.sql` は `npm run deploy:production` が適用する。API を先に配信してから Web / Android / iOS を配布する（アプリだけ先に出すと、トークン画面が `404` になる）。
