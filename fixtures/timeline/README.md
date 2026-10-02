# Timeline fixtures

ローカル開発・判定ロジックの回帰テスト用データです。本番データや端末の保存先からは参照しません。

- `remo-timeline-2026-09-01.sample.json`: 位置情報と写真メタデータを含むタイムライン例
- `remo-timeline-2026-09-01.expected.json`: 上のサンプルから作られる滞在・移動（開始・終了時刻、滞在の座標、写真数）。Web（`apps/web/src/golden.test.ts`）・Android（`SharedTimelineFixtureTest`）・iOS（`SharedTimelineFixtureTests`）が同じ結果になることを確認します。判定ロジックを意図して変更したときは `cd apps/web && npx vitest run -u src/golden.test.ts` で再生成し、Android/iOSの実装を合わせてください

Web で確認する場合は、開発サーバーを起動して「設定 → JSONをインポート」から JSON を読み込んでください。インポート後は現在のユーザーのローカルデータへ追加されます。

このデータに含まれる座標はサンプルとして扱い、実在の個人・場所を推測したり、外部へ同期したりしないでください。
