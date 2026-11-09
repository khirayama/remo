import { useEffect, useState } from "react";
import { apiOrigin } from "./api-base";
import { ApiToken, ApiTokenScope, createApiToken, deleteApiToken, listApiTokens, UnauthorizedError } from "./life-api";
import { buildMcpClientExamples } from "./mcp-clients";
import { Dialog, formatDate, Icon, IconButton, Spinner, Switch, TextField } from "./ui";

/** The MCP endpoint, on the same origin as the API the app uses. */
export const MCP_ENDPOINT_URL = `${apiOrigin}/api/mcp`;
const MAX_NAME_LENGTH = 50;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="text-button copy-button" onClick={() => {
    void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  }} aria-label={`${label}をコピー`}><Icon name="contentCopy" size={18}/>{copied ? "コピーしました" : "コピー"}</button>;
}

/**
 * Issues and revokes tokens for AI tools (MCP). A new token is shown once,
 * with setup snippets for common tools; it cannot be shown again.
 */
export function ApiTokenDialog({ onDismiss, onUnauthorized }: { onDismiss: () => void; onUnauthorized: () => void }) {
  const [tokens, setTokens] = useState<ApiToken[]>();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiTokenScope>("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<ApiToken & { token: string }>();

  const fail = (caught: unknown, message: string) => {
    if (caught instanceof UnauthorizedError) { onUnauthorized(); return; }
    setError(message);
  };

  useEffect(() => {
    listApiTokens().then(setTokens, (caught: unknown) => fail(caught, "トークンを読み込めませんでした。通信環境を確認してください"));
  }, []);

  async function issue() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await createApiToken(name.trim(), scope);
      if ("created" in result) {
        setCreated(result.created);
        setTokens((current) => [result.created, ...(current ?? [])].map(({ id, name, scope, createdAt }) => ({ id, name, scope, createdAt })));
        setName("");
        setScope("read");
      } else {
        setError(result.error === "token_limit" ? "発行できるトークンの上限に達しています。不要なトークンを削除してください" : "トークンを発行できませんでした。通信環境を確認してください");
      }
    } catch (caught) {
      fail(caught, "トークンを発行できませんでした。通信環境を確認してください");
    }
    setBusy(false);
  }

  async function revoke(token: ApiToken) {
    setBusy(true);
    setError(undefined);
    try {
      await deleteApiToken(token.id);
      setTokens((current) => current?.filter((item) => item.id !== token.id));
      if (created?.id === token.id) setCreated(undefined);
    } catch (caught) {
      fail(caught, "トークンを削除できませんでした。通信環境を確認してください");
    }
    setBusy(false);
  }

  if (created) {
    return <Dialog icon="key" title="トークンを発行しました" onDismiss={() => setCreated(undefined)} actions={
      <button type="button" className="text-button" onClick={() => setCreated(undefined)}>完了</button>
    }>
      <p>このトークンは今だけ表示されます。閉じると再表示できないため、AIツールに設定してから閉じてください。</p>
      <div className="token-value"><code>{created.token}</code><CopyButton text={created.token} label="トークン"/></div>
      <div className="token-value"><code>{MCP_ENDPOINT_URL}</code><CopyButton text={MCP_ENDPOINT_URL} label="接続先URL"/></div>
      <div className="mcp-examples">
        <strong className="dialog-strong">AIツールの設定例</strong>
        {buildMcpClientExamples(MCP_ENDPOINT_URL, created.token).map((example) => <details key={example.name}>
          <summary>{example.name}<small>{example.location}</small></summary>
          <pre>{example.snippet}</pre>
          <CopyButton text={example.snippet} label={`${example.name}の設定`}/>
        </details>)}
      </div>
    </Dialog>;
  }

  return <Dialog icon="key" title="AIツールとの接続（MCP）" onDismiss={() => { if (!busy) onDismiss(); }} actions={
    <button type="button" className="text-button" disabled={busy} onClick={onDismiss}>閉じる</button>
  }>
    <p>Claude などのAIツールから、クラウドにバックアップした滞在・移動・場所名を読み取れるようにします。トークンを知っている人は記録を読めるため、他人に共有しないでください。不要になったら削除してください。</p>
    <form className="token-form" onSubmit={(event) => { event.preventDefault(); if (!busy) void issue(); }}>
      <TextField label="名前（任意）" value={name} maxLength={MAX_NAME_LENGTH} disabled={busy} onChange={(event) => setName(event.target.value)}/>
      <button type="submit" className="filled-button" disabled={busy || tokens === undefined}>発行</button>
    </form>
    <div className="token-scope">
      <span><strong>場所と補正の編集を許可</strong><small>AIツールが場所名の登録・統合や、滞在の補正（測位の除外・滞在をつなげる・滞在ではない）を行えます。記録そのものは変更されず、補正はアプリから取り消せます。</small></span>
      <Switch checked={scope === "write"} label="場所と補正の編集を許可" onChange={() => { if (!busy) setScope((current) => current === "write" ? "read" : "write"); }}/>
    </div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {tokens === undefined
      ? !error && <div className="token-loading"><Spinner size={20}/></div>
      : tokens.length === 0
        ? <p>発行済みのトークンはありません。</p>
        : <ul className="token-list">{tokens.map((token) => <li key={token.id}>
          <span><strong>{token.name || "名前なし"}{token.scope === "write" && <span className="token-badge">編集可</span>}</strong><small>{formatDate(new Date(token.createdAt))}に発行</small></span>
          <IconButton icon="deleteOutline" label={`${token.name || "名前なし"}のトークンを削除`} disabled={busy} onClick={() => void revoke(token)}/>
        </li>)}</ul>}
  </Dialog>;
}
