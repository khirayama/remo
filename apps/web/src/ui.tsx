import { CSSProperties, InputHTMLAttributes, ReactNode, useEffect, useId, useRef } from "react";
import { ICON_PATHS, IconName } from "./icons";

// Shared building blocks mirroring apps/android UiComponents.kt / RemoTheme.kt.

// Overlays stack (settings → sheet → viewer → dialog); Escape closes only the topmost one.
const escapeStack: { current: () => void }[] = [];
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !escapeStack.length) return;
    event.preventDefault();
    escapeStack[escapeStack.length - 1].current();
  });
}

export function useEscape(onEscape: () => void) {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    const entry = { current: () => handler.current() };
    escapeStack.push(entry);
    return () => { escapeStack.splice(escapeStack.indexOf(entry), 1); };
  }, []);
}

export function Icon({ name, size = 24, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={ICON_PATHS[name]}/></svg>;
}

export type BadgeTone = "green" | "teal" | "amber" | "neutral";

/** Circular tinted badge used for timeline kinds, settings and empty states. */
export function IconBadge({ name, tone, size = 32, iconSize = 18 }: { name: IconName; tone: BadgeTone; size?: number; iconSize?: number }) {
  return <span className={`icon-badge tone-${tone}`} style={{ width: size, height: size }}><Icon name={name} size={iconSize}/></span>;
}

export function IconButton({ icon, label, onClick, disabled, className = "", iconSize = 24 }: { icon: IconName; label: string; onClick?: () => void; disabled?: boolean; className?: string; iconSize?: number }) {
  return <button type="button" className={`icon-button ${className}`} onClick={onClick} disabled={disabled} aria-label={label} title={label}><Icon name={icon} size={iconSize}/></button>;
}

/** The launcher mark from apps/android ic_launcher_foreground.xml. */
export function AppMark({ size = 28 }: { size?: number }) {
  const gradientId = useId();
  return <svg width={size} height={size} viewBox="17 14 74 74" aria-hidden="true">
    <defs><linearGradient id={gradientId} x1="25" y1="23" x2="84" y2="84" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#43F2A5"/><stop offset=".3" stopColor="#2CE9A9"/><stop offset=".57" stopColor="#10D5C3"/><stop offset=".8" stopColor="#0BC8DD"/><stop offset="1" stopColor="#0AA9B9"/></linearGradient></defs>
    <path fill={`url(#${gradientId})`} fillRule="evenodd" d="M54,17C64,17 71,23 76,33C81,43 84,53 84,59C84,68 78,73 70,77C61,81 50,84 42,84C34,84 27,80 23,74C19,68 20,59 24,51C28,42 31,32 36,25C41,18 47,17 54,17ZM54,37C58.6,37 61.82,39.74 64.12,44.34C66.42,49 67.8,53.54 67.8,56.3C67.8,60.44 65.04,62.74 61.36,64.58C57.22,66.42 52.16,67.8 48.48,67.8C44.8,67.8 41.58,65.96 39.74,63.2C37.9,60.44 38.36,56.3 40.2,52.62C42.04,48.48 43.42,43.88 45.72,40.66C48.02,37.44 50.78,37 54,37Z"/>
  </svg>;
}

export function Spinner({ size = 24, light = false }: { size?: number; light?: boolean }) {
  return <span className={`spinner${light ? " light" : ""}`} style={{ width: size, height: size }} role="progressbar" aria-label="読み込み中"/>;
}

/** 36×4 grab bar with 10/6px breathing room. */
export function SheetHandle() {
  return <span className="sheet-grabber" aria-hidden="true"><span/></span>;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch${checked ? " checked" : ""}`} onClick={(event) => { event.stopPropagation(); onChange(); }}><span/></button>;
}

/** Material 3 outlined text field with a floating label. */
export function TextField({ label, leading, trailing, supporting, error, className = "", ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; leading?: IconName; trailing?: ReactNode; supporting?: string; error?: string }) {
  const id = useId();
  return <div className={`text-field${error ? " invalid" : ""}${leading ? " has-leading" : ""} ${className}`}>
    <div className="text-field-box">
      {leading && <Icon name={leading} className="text-field-leading"/>}
      <input id={id} placeholder=" " aria-invalid={Boolean(error)} {...input}/>
      <label htmlFor={id}>{label}</label>
      {trailing}
    </div>
    {(error ?? supporting) && <p className="text-field-supporting">{error ?? supporting}</p>}
  </div>;
}

/** Material 3 AlertDialog: 28px corners, optional icon, text actions. */
export function Dialog({ icon, iconTone = "neutral", title, children, actions, onDismiss, label }: { icon?: IconName; iconTone?: "danger" | "neutral"; title: string; children?: ReactNode; actions: ReactNode; onDismiss: () => void; label?: string }) {
  const cardRef = useRef<HTMLElement>(null);
  useEscape(onDismiss);
  useEffect(() => { cardRef.current?.querySelector<HTMLElement>("input, button:not([disabled])")?.focus(); }, []);
  return <div className="scrim dialog-scrim" onMouseDown={(event) => event.target === event.currentTarget && onDismiss()}>
    <section ref={cardRef} className={`alert-dialog${icon ? " with-icon" : ""}`} role="dialog" aria-modal="true" aria-label={label ?? title}>
      {icon && <Icon name={icon} className={`alert-dialog-icon ${iconTone}`}/>}
      <h2>{title}</h2>
      {children && <div className="alert-dialog-text">{children}</div>}
      <div className="alert-dialog-actions">{actions}</div>
    </section>
  </div>;
}

export function ConfirmDeleteDialog({ title, message, confirmLabel = "削除する", onDismiss, onConfirm }: { title: string; message: string; confirmLabel?: string; onDismiss: () => void; onConfirm: () => void }) {
  return <Dialog icon="deleteOutline" iconTone="danger" title={title} onDismiss={onDismiss} actions={<>
    <button type="button" className="text-button" onClick={onDismiss}>キャンセル</button>
    <button type="button" className="text-button danger" onClick={() => { onDismiss(); onConfirm(); }}>{confirmLabel}</button>
  </>}><p>{message}</p></Dialog>;
}

// ---- Formatting (UiComponents.kt) -----------------------------------------

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const pad = (value: number) => String(value).padStart(2, "0");
const toDate = (value: string | Date) => typeof value === "string" ? new Date(value) : value;
export const dayDate = (key: string) => new Date(`${key}T12:00:00`);

/** "9月1日（火）" */
export function formatDayTitle(value: string | Date) { const date = toDate(value); return `${date.getMonth() + 1}月${date.getDate()}日（${WEEKDAYS[date.getDay()]}）`; }
/** "2026年9月1日（火）" */
export function formatDate(value: string | Date) { const date = toDate(value); return `${date.getFullYear()}年${formatDayTitle(date)}`; }
export function formatTime(value: string | Date) { const date = toDate(value); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; }
/** "9月1日（火） 08:31" */
export function formatDayTime(value: string | Date) { return `${formatDayTitle(value)} ${formatTime(value)}`; }
/** "9月1日 08:31" */
export function formatBackupTime(value: string | Date) { const date = toDate(value); return `${date.getMonth() + 1}月${date.getDate()}日 ${formatTime(date)}`; }

export function activityDurationLabel(durationMs: number) {
  if (durationMs < 60_000) return "1分未満";
  const minutes = Math.floor(durationMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}時間${remainder ? `${remainder}分` : ""}` : `${minutes}分`;
}

export function elapsedStayLabel(durationMs: number) {
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}時間${remainder ? `${remainder}分` : ""}` : `${minutes}分`;
}

export function formatDistance(distance?: number) {
  if (distance === undefined || !Number.isFinite(distance)) return "距離不明";
  return distance < 1000 ? `${Math.floor(distance)} m` : `${(distance / 1000).toFixed(1)} km`;
}

export function mediaSummary(photoCount: number, videoCount: number) {
  return [
    photoCount > 0 ? `写真 ${photoCount}枚` : "",
    videoCount > 0 ? `動画 ${videoCount}本` : "",
  ].filter(Boolean).join(" · ") || "メディアなし";
}
