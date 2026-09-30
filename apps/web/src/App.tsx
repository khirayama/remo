import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { authClient } from "./auth-client";
import { deleteAccount, deleteAllCloudData, synchronizeEvents } from "./life-api";
import { clearEvents, clearSyncState, dateKey, downloadExport, enqueueSync, eventsInRange, ExportRange, LifeEvent, loadEvents, loadSyncQueue, prepareLocalStorage, readImport, saveEvents, sortNewest } from "./life-log";
import { readPhotoMetadata } from "./photo-metadata";
import { deleteAllPhotoPreviews, deletePhotoPreview, listLocalPhotoPreviewIds, loadPhotoPreview, makePhotoThumbnail, migratePhotoPreviews, savePhotoPreview } from "./photo-storage";
import { loadRemotePhotoPreview, loadRemotePhotoPreviews, uploadPhotoPreview } from "./photo-api";
import { buildStayVisitHistory, buildTimelineSnapshot, distanceMeters, PhotoCluster, StayCluster, StayPlace, StayVisit, StayVisitHistory, TimelineActivity, TimelineRenderSnapshot, stayCircleRadiusMeters, suggestPhotoLocation } from "./timeline-map";
import { AllTimeStayPlace, buildAllTimeStayPlaces, historyOf, parseStayIndexCache, StayIndexCache, StaySummary, stayVisitHistoryFromStays, updateStayIndex } from "./stay-index";
import { deleteStayIndexCache, loadStayIndexCache, saveStayIndexCache } from "./stay-index-storage";
import { isFreshFix, isStationary } from "./capture-policy";
import { IconName } from "./icons";
import { activityDurationLabel, AppMark, ConfirmDeleteDialog, Dialog, dayDate, elapsedStayLabel, formatBackupTime, formatDate, formatDayTime, formatDayTitle, formatDistance, formatTime, Icon, IconBadge, IconButton, mediaSummary, SheetHandle, Spinner, Switch, TextField, useEscape } from "./ui";

const NORMAL_INTERVAL_SECONDS = 10;
const STATIONARY_INTERVAL_SECONDS = 300; // 5 minutes
const STATIONARY_HISTORY_WINDOW_MS = 5 * 60 * 1000;
const MOVEMENT_DISTANCE_M = 75;
const MOVEMENT_SPEED_MPS = 1.2;
const CAPTURE_RUNNING_STATUS = "通常10秒／静止時5分で記録中";

// Map colors shared with apps/android TimelineMap.kt / RouteRenderPath.kt.
const ROUTE_COLOR = "rgb(14, 133, 119)";
const FOCUS_ROUTE_COLOR = "rgb(8, 94, 84)";
const STAY_COLOR = "rgb(47, 90, 69)";
const DEFAULT_CENTER: [number, number] = [35.6812, 139.7671];
const MAP_MAX_ZOOM = 19;
const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

/** Unassigned photos taken within this gap of each other share one timeline row. */
const PHOTO_GROUP_GAP_MS = 30 * 60 * 1000;
const DESKTOP_QUERY = "(min-width: 721px)";
/** Height of the controls stacked over the top of the map. */
const MAP_TOP_INSET = 112;

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function hasUsableCoordinates(event: Pick<LifeEvent, "latitude" | "longitude">): event is Pick<LifeEvent, "latitude" | "longitude"> & { latitude: number; longitude: number } {
  return typeof event.latitude === "number" && Number.isFinite(event.latitude) && event.latitude >= -90 && event.latitude <= 90
    && typeof event.longitude === "number" && Number.isFinite(event.longitude) && event.longitude >= -180 && event.longitude <= 180
    && !(event.latitude === 0 && event.longitude === 0);
}

function coordinates(event: { latitude?: number; longitude?: number }) {
  return hasUsableCoordinates(event) ? `${event.latitude.toFixed(5)}, ${event.longitude.toFixed(5)}` : "位置情報なし";
}

function eventMediaSummary(event: Pick<LifeEvent, "mediaType" | "photoCount">) {
  return event.mediaType === "video" ? `動画 ${event.photoCount}本` : `写真 ${event.photoCount}枚`;
}

function mediaSummaryOf(events: LifeEvent[]) {
  return mediaSummary(
    events.filter((event) => event.mediaType !== "video").reduce((sum, event) => sum + event.photoCount, 0),
    events.filter((event) => event.mediaType === "video").reduce((sum, event) => sum + event.photoCount, 0),
  );
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
}

// ---- Authentication -------------------------------------------------------

function AuthScreen({ onClose }: { onClose: () => void }) {
  const [signUp, setSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  useEscape(onClose);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage(undefined);
    try {
      const result = signUp
        ? await authClient.signUp.email({ email, password, name: email.split("@")[0] || "Remo user" })
        : await authClient.signIn.email({ email, password });
      if (result.error) setMessage(result.error.message ?? "認証に失敗しました。");
    } catch {
      setMessage("接続できませんでした。通信環境を確認してください。");
    } finally {
      setIsSubmitting(false);
    }
  }

  function selectMode(next: boolean) {
    setSignUp(next);
    setMessage(undefined);
  }

  return <main className="auth-screen" role="dialog" aria-modal="true" aria-label="ログイン">
    <div className="auth-column">
      <div className="auth-top"><IconButton icon="close" label="閉じる" onClick={onClose}/></div>
      <div className="auth-brand"><span className="auth-brand-mark"><AppMark size={30}/></span><span>remo</span></div>
      <h1>毎日を、静かに。<br/>自分のために。</h1>
      <p className="auth-lead">位置と写真を1日の地図にまとめて、あとから眺められます。ログインすると記録がバックアップされ、Webや他の端末でも見られます。</p>
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        <div className="segmented" role="tablist" aria-label="認証モード">
          <button type="button" role="tab" aria-selected={!signUp} className={!signUp ? "active" : ""} onClick={() => selectMode(false)}>ログイン</button>
          <button type="button" role="tab" aria-selected={signUp} className={signUp ? "active" : ""} onClick={() => selectMode(true)}>新規登録</button>
        </div>
        <div className="auth-heading">
          <h2>{signUp ? "はじめましょう" : "おかえりなさい"}</h2>
          <p>{signUp ? "メールアドレスとパスワードで登録します。" : "登録したメールアドレスでログインします。"}</p>
        </div>
        <TextField className="rounded" label="メールアドレス" leading="email" type="email" autoComplete={signUp ? "username" : "email"} value={email} onChange={(event) => setEmail(event.target.value)} required/>
        <TextField
          className="rounded"
          label="パスワード"
          leading="lock"
          type={showPassword ? "text" : "password"}
          autoComplete={signUp ? "new-password" : "current-password"}
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          supporting={signUp ? "8文字以上" : undefined}
          required
          trailing={<IconButton icon={showPassword ? "visibilityOff" : "visibility"} label={showPassword ? "パスワードを隠す" : "パスワードを表示"} onClick={() => setShowPassword((value) => !value)}/>}
        />
        {message && <p className="error-container" role="alert"><Icon name="errorOutline" size={20}/><span>{message}</span></p>}
        <button className="filled-button wide" disabled={isSubmitting}>{isSubmitting ? <Spinner size={20} light/> : signUp ? "アカウントを作成" : "ログイン"}</button>
      </form>
      <button type="button" className="text-button auth-skip" onClick={onClose}>ログインせずに使う</button>
    </div>
  </main>;
}

// ---- Map ------------------------------------------------------------------

type MapCoordinate = { latitude: number; longitude: number };
type MapFocus = MapCoordinate & {
  activityId: string;
  kind: "movement" | "stay";
  path: [number, number][];
};
type CurrentLocation = MapCoordinate & { accuracyMeters?: number };
/** Parts of the map covered by overlays; camera moves keep targets inside the rest. */
type MapInsets = { top: number; right: number; bottom: number; left: number };

function mapFocus(activity: TimelineActivity): MapFocus {
  return activity.kind === "stay"
    ? { activityId: activity.id, kind: "stay", latitude: activity.latitude, longitude: activity.longitude, path: [[activity.latitude, activity.longitude]] }
    : { activityId: activity.id, kind: "movement", latitude: activity.to[0], longitude: activity.to[1], path: activity.path };
}

/** Centers [target] inside the visible (uncovered) part of the map. */
function centerInView(map: L.Map, target: L.LatLngExpression, zoom: number, insets: MapInsets, animate: boolean) {
  const offset = L.point((insets.left - insets.right) / 2, (insets.top - insets.bottom) / 2);
  const center = map.unproject(map.project(target, zoom).subtract(offset), zoom);
  map.setView(center, zoom, { animate });
}

/** Fits every point into the visible area, matching Android's fitMap. */
function fitMap(map: L.Map, points: [number, number][], insets: MapInsets, animate: boolean, fallback?: MapCoordinate) {
  if (!points.length) {
    if (fallback) centerInView(map, [fallback.latitude, fallback.longitude], 16, insets, animate);
    else centerInView(map, DEFAULT_CENTER, 11, insets, animate);
    return;
  }
  const bounds = L.latLngBounds(points);
  const span = Math.max(bounds.getNorth() - bounds.getSouth(), bounds.getEast() - bounds.getWest());
  if (points.length === 1 || span < 0.0005) {
    centerInView(map, bounds.getCenter(), points.length === 1 ? 17 : 18, insets, animate);
    return;
  }
  map.fitBounds(bounds, { paddingTopLeft: [insets.left + 48, insets.top + 48], paddingBottomRight: [insets.right + 48, insets.bottom + 48], maxZoom: 18, animate });
}

function photoMarkerHtml(preview: string | undefined, count: number, isVideo: boolean) {
  const glyph = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${isVideo ? "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" : "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"}"/></svg>`;
  const face = preview ? `<img src="${escapeHtml(preview)}" alt="" />` : `<span class="photo-marker-glyph">${glyph}</span>`;
  const badge = count > 1 ? `<b class="photo-marker-count">${count > 99 ? "99+" : count}</b>` : "";
  return `<span class="photo-marker"><span class="photo-marker-ring">${face}</span>${badge}</span>`;
}

/** Screen radius of an all-time place: log-scaled so home does not cover the map. */
function placeMarkerRadius(totalDurationMs: number) {
  const hours = Math.max(0, totalDurationMs) / 3_600_000;
  return Math.min(22, 5 + Math.log2(1 + hours) * 2.2);
}

/** Places visited long ago fade, like the day's route. */
function placeMarkerOpacity(lastVisitedAt: string, now: number) {
  const ageDays = Math.max(0, now - new Date(lastVisitedAt).getTime()) / 86_400_000;
  return Math.max(0.12, 0.55 - Math.log10(1 + ageDays) * 0.15);
}

type SavedView = { center: L.LatLng; zoom: number };

function LeafletMap({ timeline, previews, viewKey, focus, currentLocation, places, selectedPlaceId, getInsets, onSelectPhotos, onSelectPlace }: { timeline: TimelineRenderSnapshot; previews: Map<string, string>; viewKey: string; focus?: MapFocus; currentLocation?: CurrentLocation; places?: AllTimeStayPlace[]; selectedPlaceId?: string; getInsets: () => MapInsets; onSelectPhotos: (photos: LifeEvent[]) => void; onSelectPlace: (place: AllTimeStayPlace) => void }) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const placeRendererRef = useRef<L.Renderer | null>(null);
  const currentLocationLayerRef = useRef<L.LayerGroup | null>(null);
  const currentLocationMarkerRef = useRef<L.CircleMarker | null>(null);
  const onSelectPhotosRef = useRef(onSelectPhotos);
  const onSelectPlaceRef = useRef(onSelectPlace);
  const focusedViewKeyRef = useRef<string | null>(null);
  // The all-places view keeps its camera while the user visits a day and comes back.
  const allPlacesViewRef = useRef<SavedView | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const { movementSegments, stayClusters, photoClusters, mapNodes } = timeline;
  const allPlaces = places !== undefined;
  useEffect(() => { onSelectPhotosRef.current = onSelectPhotos; }, [onSelectPhotos]);
  useEffect(() => { onSelectPlaceRef.current = onSelectPlace; }, [onSelectPlace]);
  const isToday = !allPlaces && viewKey === dateKey(new Date());
  const fitPoints = useMemo(() => {
    if (places) return places.map((place) => [place.latitude, place.longitude] as [number, number]);
    return currentLocation && isToday ? [...mapNodes, [currentLocation.latitude, currentLocation.longitude] as [number, number]] : mapNodes;
  }, [currentLocation, isToday, mapNodes, places]);

  useEffect(() => {
    const element = mapElementRef.current;
    if (!element) return;
    const map = L.map(element, { attributionControl: true, zoomControl: false, minZoom: 2, maxZoom: MAP_MAX_ZOOM, worldCopyJump: true }).setView(DEFAULT_CENTER, 11);
    map.attributionControl.setPrefix(false);
    L.tileLayer(TILE_URL, { maxZoom: MAP_MAX_ZOOM, attribution: "© OpenStreetMap" }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    // Hundreds of place circles draw far faster on one canvas than as SVG nodes.
    placeRendererRef.current = L.canvas({ padding: 0.5 });
    currentLocationLayerRef.current = L.layerGroup().addTo(map);
    map.on("moveend", () => {
      if (focusedViewKeyRef.current === "all:ready") allPlacesViewRef.current = { center: map.getCenter(), zoom: map.getZoom() };
    });
    setReady(true);
    return () => { map.remove(); mapRef.current = null; layerRef.current = null; placeRendererRef.current = null; currentLocationLayerRef.current = null; currentLocationMarkerRef.current = null; };
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!ready || !layer || !places) return;
    layer.clearLayers();
    const now = Date.now();
    const renderer = placeRendererRef.current ?? undefined;
    // Smaller circles last so a frequent place never hides a rare one nearby.
    [...places].sort((first, second) => second.totalDurationMs - first.totalDurationMs).forEach((place) => {
      const selected = place.id === selectedPlaceId;
      const opacity = placeMarkerOpacity(place.lastVisitedAt, now);
      const marker = L.circleMarker([place.latitude, place.longitude], {
        renderer,
        radius: placeMarkerRadius(place.totalDurationMs) + (selected ? 3 : 0),
        color: selected ? "#ffffff" : STAY_COLOR,
        weight: selected ? 3 : 1,
        opacity: selected ? 1 : Math.min(1, opacity + 0.3),
        fillColor: STAY_COLOR,
        fillOpacity: selected ? 0.9 : opacity,
      }).addTo(layer);
      marker.on("click", () => onSelectPlaceRef.current(place));
    });
  }, [places, ready, selectedPlaceId]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!ready || !layer || allPlaces) return;
    let openPopupKey: string | undefined;
    layer.eachLayer((item) => {
      if (item.isPopupOpen()) openPopupKey = (item as L.Layer & { remoPopupKey?: string }).remoPopupKey;
    });
    layer.clearLayers();
    let popupToRestore: L.Layer | undefined;
    const dimmed = Boolean(focus);
    movementSegments.forEach((segment) => L.polyline([segment.from, segment.to], { color: ROUTE_COLOR, weight: 4, opacity: dimmed ? segment.opacity * 0.2 : segment.opacity, lineCap: "round", lineJoin: "round", interactive: false }).addTo(layer));
    stayClusters.forEach((stay) => {
      const selected = focus?.kind === "stay" && focus.activityId === stay.id;
      const circle = L.circle([stay.latitude, stay.longitude], {
        radius: stayCircleRadiusMeters(stay.durationMs) + (selected ? 8 : 0),
        color: STAY_COLOR,
        weight: selected ? 2.5 : 1.5,
        opacity: !focus ? 0.67 : selected ? 1 : 0.2,
        fillColor: STAY_COLOR,
        fillOpacity: !focus ? 0.18 : selected ? 0.35 : 0.055,
      }).addTo(layer);
      const popupKey = `stay:${stay.events[0]?.event.id ?? stay.id}`;
      (circle as L.Circle & { remoPopupKey?: string }).remoPopupKey = popupKey;
      circle.bindPopup(`<div class="map-popup"><strong>滞在</strong><span>${escapeHtml(formatTime(stay.startedAt))} – ${escapeHtml(formatTime(stay.endedAt))} · ${escapeHtml(elapsedStayLabel(stay.durationMs))}</span></div>`, { className: "remo-popup", closeButton: false });
      if (openPopupKey === popupKey) popupToRestore = circle;
    });
    if (focus?.kind === "movement" && focus.path.length > 1) {
      L.polyline(focus.path, { color: FOCUS_ROUTE_COLOR, weight: 6, opacity: 1, lineCap: "round", lineJoin: "round", interactive: false }).addTo(layer);
    }
    photoClusters.forEach((cluster: PhotoCluster) => {
      const first = cluster.events[0];
      const icon = L.divIcon({ className: "remo-photo-marker", html: photoMarkerHtml(previews.get(first?.id), cluster.photoCount + cluster.videoCount, first?.mediaType === "video"), iconSize: [48, 48], iconAnchor: [24, 24] });
      const marker = L.marker([cluster.latitude, cluster.longitude], { icon, title: mediaSummary(cluster.photoCount, cluster.videoCount), zIndexOffset: 300, opacity: dimmed ? 0.4 : 1 }).addTo(layer);
      marker.on("click", () => onSelectPhotosRef.current(cluster.events));
    });
    popupToRestore?.openPopup();
  }, [allPlaces, focus, movementSegments, photoClusters, previews, ready, stayClusters]);

  // Current location changes frequently while capturing. Keep it in its own
  // layer so a new GPS sample does not rebuild every route/photo/stay layer.
  useEffect(() => {
    const layer = currentLocationLayerRef.current;
    if (!ready || !layer) return;
    if (!currentLocation) {
      currentLocationMarkerRef.current?.remove();
      currentLocationMarkerRef.current = null;
      return;
    }
    const point: L.LatLngExpression = [currentLocation.latitude, currentLocation.longitude];
    const marker = currentLocationMarkerRef.current ?? L.circleMarker(point, { radius: 8, color: "#ffffff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1, className: "current-location-marker" }).addTo(layer);
    marker.setLatLng(point);
    marker.bindPopup(`<div class="map-popup"><strong>現在地</strong><span>${escapeHtml(coordinates(currentLocation))}</span></div>`, { className: "remo-popup", closeButton: false });
    currentLocationMarkerRef.current = marker;
  }, [currentLocation, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (places) {
      // Keep the current camera until the places are known, then fit them once.
      if (!places.length || focusedViewKeyRef.current === "all:ready") return;
      focusedViewKeyRef.current = "all:ready";
      map.invalidateSize();
      const saved = allPlacesViewRef.current;
      if (saved) map.setView(saved.center, saved.zoom, { animate: false });
      else fitMap(map, fitPoints, getInsets(), false);
      return;
    }
    const focusKey = `${viewKey}:${isToday && currentLocation ? "current" : "timeline"}`;
    if (focusedViewKeyRef.current === focusKey) return;
    // Mark the day first: fitting fires moveend, which must not overwrite the saved all-places view.
    focusedViewKeyRef.current = focusKey;
    map.invalidateSize();
    fitMap(map, fitPoints, getInsets(), false, currentLocation);
  }, [currentLocation, fitPoints, getInsets, isToday, places, ready, viewKey]);

  useEffect(() => {
    const map = mapRef.current;
    const place = places?.find((candidate) => candidate.id === selectedPlaceId);
    if (!ready || !map || !place) return;
    centerInView(map, [place.latitude, place.longitude], Math.max(map.getZoom(), 15), getInsets(), true);
    // Only a newly selected place moves the camera, not a refreshed place list.
  }, [getInsets, ready, selectedPlaceId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !focus || allPlaces) return;
    const insets = getInsets();
    if (focus.path.length > 1) {
      map.fitBounds(L.latLngBounds(focus.path), { paddingTopLeft: [insets.left + 40, insets.top + 40], paddingBottomRight: [insets.right + 40, insets.bottom + 40], maxZoom: 18, animate: true });
    } else {
      centerInView(map, [focus.latitude, focus.longitude], Math.max(map.getZoom(), 16), insets, true);
    }
  }, [allPlaces, focus, getInsets, ready]);

  return <div className="leaflet-map-shell">
    <div className="leaflet-map" ref={mapElementRef} aria-label={allPlaces ? "これまでに滞在した場所の地図" : "位置情報と写真の地図"}/>
    <div className="map-controls map-controls-end">
      {currentLocation && <MapControlButton icon="myLocation" label="現在地を表示" onClick={() => { const map = mapRef.current; if (map) centerInView(map, [currentLocation.latitude, currentLocation.longitude], 16, getInsets(), true); }}/>}
      <MapControlButton icon="zoomOutMap" label={allPlaces ? "すべての滞在場所を表示" : "この日の記録全体を表示"} disabled={!fitPoints.length} onClick={() => { const map = mapRef.current; if (map) fitMap(map, fitPoints, getInsets(), true); }}/>
    </div>
  </div>;
}

/** 48px floating control drawn on top of the map. */
function MapControlButton({ icon, label, disabled, onClick }: { icon: IconName; label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="map-control-button" onClick={onClick} disabled={disabled} aria-label={label} title={label}><Icon name={icon}/></button>;
}

function RecordingPill({ recording, onClick }: { recording: boolean; onClick: () => void }) {
  return <button type="button" className="recording-pill" onClick={onClick}><i className={recording ? "live" : ""}/>{recording ? "記録中" : "記録を停止中"}</button>;
}

// ---- Timeline sheet -------------------------------------------------------

type SheetItem =
  | { kind: "activity"; id: string; startedAt: string; activity: TimelineActivity }
  | { kind: "photos"; id: string; startedAt: string; entries: LifeEvent[] };

function buildSheetItems(timeline: TimelineRenderSnapshot): SheetItem[] {
  const assignedPhotoIds = new Set(timeline.activities.flatMap((activity) => activity.photos.map((photo) => photo.id)));
  const ordered: SheetItem[] = [
    ...timeline.activities.map((activity) => ({ kind: "activity" as const, id: activity.id, startedAt: activity.startedAt, activity })),
    ...timeline.displayEvents.filter((event) => event.source === "photo" && !assignedPhotoIds.has(event.id))
      .map((event) => ({ kind: "photos" as const, id: `photos:${event.id}`, startedAt: event.startedAt, entries: [event] })),
  ].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || (a.kind === "activity" ? -1 : 1));
  const result: SheetItem[] = [];
  for (const item of ordered) {
    const previous = result.at(-1);
    if (item.kind === "photos" && previous?.kind === "photos"
      && new Date(item.startedAt).getTime() - new Date(previous.entries.at(-1)!.startedAt).getTime() <= PHOTO_GROUP_GAP_MS) {
      result[result.length - 1] = { ...previous, entries: [...previous.entries, ...item.entries] };
    } else {
      result.push(item);
    }
  }
  return result;
}

function daySummary(timeline: TimelineRenderSnapshot) {
  const media = timeline.displayEvents.filter((event) => event.source === "photo");
  return {
    distanceMeters: timeline.activities.reduce((sum, activity) => sum + (activity.kind === "movement" && Number.isFinite(activity.distanceMeters) ? activity.distanceMeters : 0), 0),
    stayCount: timeline.activities.filter((activity) => activity.kind === "stay").length,
    mediaCount: media.reduce((sum, event) => sum + event.photoCount, 0),
  };
}

function DayHeader({ selectedDate, onDateChange }: { selectedDate: string; onDateChange: (value: string) => void }) {
  const today = dateKey(new Date());
  const isToday = selectedDate >= today;
  const inputRef = useRef<HTMLInputElement>(null);
  const yesterday = (() => { const date = dayDate(today); date.setDate(date.getDate() - 1); return dateKey(date); })();
  const relative = selectedDate === today ? "今日" : selectedDate === yesterday ? "昨日" : undefined;
  function shift(days: number) {
    const date = dayDate(selectedDate);
    date.setDate(date.getDate() + days);
    onDateChange(dateKey(date));
  }
  function openPicker() {
    const input = inputRef.current;
    if (!input) return;
    try { input.showPicker(); } catch { input.focus(); }
  }
  return <div className="day-header">
    <button type="button" className="day-title" onClick={openPicker} aria-label="日付を選択">
      <span><strong>{formatDayTitle(dayDate(selectedDate))}</strong><small>{[`${selectedDate.slice(0, 4)}年`, relative].filter(Boolean).join(" · ")}</small></span>
      <Icon name="expandMore" size={20}/>
      <input ref={inputRef} type="date" tabIndex={-1} aria-hidden="true" value={selectedDate} max={today} onChange={(event) => event.target.value && onDateChange(event.target.value)}/>
    </button>
    {!isToday && <button type="button" className="text-button" onClick={() => onDateChange(today)}>今日</button>}
    <IconButton icon="chevronLeft" label="前の日" onClick={() => shift(-1)}/>
    <IconButton icon="chevronRight" label="次の日" onClick={() => shift(1)} disabled={isToday}/>
  </div>;
}

function SummaryChip({ icon, tone, text }: { icon: IconName; tone: string; text: string }) {
  return <span className="summary-chip"><Icon name={icon} size={16} className={`tint-${tone}`}/>{text}</span>;
}

function PhotoThumb({ event, preview, overlay, onClick, large = false }: { event: LifeEvent; preview?: string; overlay?: string; onClick: () => void; large?: boolean }) {
  const isVideo = event.mediaType === "video";
  return <button type="button" className={`photo-thumb${large ? " large" : ""}`} onClick={(click) => { click.stopPropagation(); onClick(); }} aria-label={`${formatTime(event.startedAt)} ${eventMediaSummary(event)}`}>
    {preview ? <img src={preview} alt="" loading="lazy" decoding="async"/> : <Icon name={isVideo ? "videocam" : "photoCamera"} size={large ? 24 : 20} className="photo-thumb-glyph"/>}
    {isVideo && <Icon name="playCircle" size={16} className="photo-thumb-video"/>}
    {overlay && <span className="photo-thumb-overlay">{overlay}</span>}
  </button>;
}

function PhotoStrip({ entries, previews, onOpen }: { entries: LifeEvent[]; previews: Map<string, string>; onOpen: () => void }) {
  const visible = entries.slice(0, 4);
  const hidden = entries.slice(visible.length).reduce((sum, entry) => sum + entry.photoCount, 0);
  return <div className="photo-strip">{visible.map((entry, index) => <PhotoThumb key={entry.id} event={entry} preview={previews.get(entry.id)} overlay={index === visible.length - 1 && hidden > 0 ? `+${hidden}` : undefined} onClick={onOpen}/>)}</div>;
}

/** Row geometry shared by every timeline entry so the rail stays continuous. */
function TimelineRow({ startedAt, endedAt, isFirst, isLast, badge, children }: { startedAt: string; endedAt?: string; isFirst: boolean; isLast: boolean; badge: ReactNode; children: ReactNode }) {
  return <li className={`timeline-row${isFirst ? " first" : ""}${isLast ? " last" : ""}`}>
    <time className="timeline-row-time" dateTime={startedAt}><span>{formatTime(startedAt)}</span>{endedAt && <small>{formatTime(endedAt)}</small>}</time>
    <span className="timeline-row-badge">{badge}</span>
    <div className="timeline-row-content">{children}</div>
  </li>;
}

function RowTitle({ title, trailing }: { title: string; trailing?: string }) {
  return <span className="row-title"><strong>{title}</strong>{trailing && <span>{trailing}</span>}</span>;
}

function ActivityRow({ activity, isFirst, isLast, selected, previews, onFocus, onSelectPhotos, onOpenHistory }: { activity: TimelineActivity; isFirst: boolean; isLast: boolean; selected: boolean; previews: Map<string, string>; onFocus: () => void; onSelectPhotos: (photos: LifeEvent[]) => void; onOpenHistory: () => void }) {
  const stay = activity.kind === "stay";
  return <TimelineRow startedAt={activity.startedAt} endedAt={activity.endedAt} isFirst={isFirst} isLast={isLast} badge={stay ? <IconBadge name="place" tone="green"/> : <IconBadge name="route" tone="teal"/>}>
    <div className={`row-card ${activity.kind}${selected ? " selected" : ""}`} role="button" tabIndex={0} aria-pressed={selected} onClick={onFocus} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onFocus(); } }}>
      <RowTitle title={stay ? "滞在" : "移動"} trailing={activityDurationLabel(activity.durationMs)}/>
      {!stay && <span className="row-subtitle">{formatDistance(activity.distanceMeters)}</span>}
      {activity.photos.length > 0 && <PhotoStrip entries={activity.photos} previews={previews} onOpen={() => onSelectPhotos(activity.photos)}/>}
      {stay && selected && <button type="button" className="text-button row-card-action" onClick={(event) => { event.stopPropagation(); onOpenHistory(); }}><Icon name="restore" size={18}/>この場所の訪問履歴</button>}
    </div>
  </TimelineRow>;
}

function PhotoGroupRow({ entries, isFirst, isLast, previews, onOpen }: { entries: LifeEvent[]; isFirst: boolean; isLast: boolean; previews: Map<string, string>; onOpen: () => void }) {
  const first = entries[0].startedAt;
  const last = entries.at(-1)!.startedAt;
  return <TimelineRow startedAt={first} endedAt={formatTime(last) !== formatTime(first) ? last : undefined} isFirst={isFirst} isLast={isLast} badge={<IconBadge name="photoCamera" tone="amber"/>}>
    <div className="row-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}>
      <RowTitle title={mediaSummaryOf(entries)}/>
      {entries.every((entry) => !hasUsableCoordinates(entry)) && <span className="row-subtitle">位置情報なし</span>}
      <PhotoStrip entries={entries} previews={previews} onOpen={onOpen}/>
    </div>
  </TimelineRow>;
}

function StayPlacesSection({ places, onOpenHistory }: { places: StayPlace[]; onOpenHistory: (place: MapCoordinate) => void }) {
  const [expanded, setExpanded] = useState(false);
  const ordered = useMemo(() => [...places].sort((a, b) => b.visitCount - a.visitCount || b.totalDurationMs - a.totalDurationMs), [places]);
  return <section className="stay-places">
    <button type="button" className="stay-places-header" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <span><strong>滞在した場所</strong><small>{places.length}か所 · 100m以内の滞在は同じ場所にまとめています</small></span>
      <Icon name={expanded ? "expandLess" : "expandMore"}/>
    </button>
    {expanded && <ul>{ordered.map((place) => <li key={place.id}>
      <button type="button" className="stay-place-row" onClick={() => onOpenHistory(place)} aria-label={`${coordinates(place)}の訪問履歴`}>
        <IconBadge name="place" tone="green"/>
        <div><strong>{coordinates(place)}</strong><small>{place.visitCount}回 · 合計{activityDurationLabel(place.totalDurationMs)} · {place.visits.map((visit: StayCluster) => formatTime(visit.startedAt)).join(" / ")}</small></div>
        <Icon name="chevronRight" className="stay-place-chevron"/>
      </button>
    </li>)}</ul>}
  </section>;
}

/** All-time visits to one place, grouped by day. Tapping a day opens it. */
function PlaceHistorySheet({ history, place, onClose, onOpenDay }: { history?: StayVisitHistory; place: MapCoordinate; onClose: () => void; onOpenDay: (day: string) => void }) {
  const days = useMemo(() => {
    const groups: { day: string; visits: StayVisit[] }[] = [];
    history?.visits.forEach((visit) => {
      const day = dateKey(visit.startedAt);
      const last = groups.at(-1);
      if (last?.day === day) last.visits.push(visit);
      else groups.push({ day, visits: [visit] });
    });
    return groups;
  }, [history]);
  const first = history?.visits.at(-1);
  useEscape(onClose);
  return <div className="scrim sheet-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-sheet" role="dialog" aria-modal="true" aria-label="訪問履歴">
      <SheetHandle/>
      <header className="modal-sheet-header">
        <div><h2>訪問履歴</h2><p>{coordinates(place)} · 100m以内の滞在</p></div>
        <IconButton icon="close" label="閉じる" onClick={onClose}/>
      </header>
      {history ? <>
        <div className="place-history-summary">
          <SummaryChip icon="place" tone="green" text={`${history.visits.length}回`}/>
          <SummaryChip icon="calendarMonth" tone="teal" text={`${history.dayCount}日`}/>
          <SummaryChip icon="restore" tone="amber" text={`合計${activityDurationLabel(history.totalDurationMs)}`}/>
        </div>
        {first && <p className="place-history-since">{formatDate(first.startedAt)}から記録</p>}
        <ol className="place-history-list">{days.map(({ day, visits }) => <li key={day}>
          <button type="button" className="place-history-day" onClick={() => onOpenDay(day)}>
            <span>
              <strong>{formatDate(dayDate(day))}</strong>
              {visits.map((visit) => <small key={visit.id}>{formatTime(visit.startedAt)}–{formatTime(visit.endedAt)} · {activityDurationLabel(visit.durationMs)}</small>)}
            </span>
            <Icon name="chevronRight"/>
          </button>
        </li>)}</ol>
      </> : <div className="all-places-status"><Spinner size={20}/><span>過去の記録を集計しています…</span></div>}
    </section>
  </div>;
}

type PlacePeriod = "all" | "year" | "month";
const PLACE_PERIODS: { value: PlacePeriod; label: string; days?: number }[] = [
  { value: "all", label: "全期間" },
  { value: "year", label: "1年", days: 365 },
  { value: "month", label: "30日", days: 30 },
];
const PLACE_LIST_PAGE = 50;

/** Sheet content of the all-places map: every place ever stayed at, most visited first. */
function AllPlacesSheetContent({ places, stays, progress, period, selectedPlaceId, onPeriodChange, onSelectPlace }: { places?: AllTimeStayPlace[]; stays?: StaySummary[]; progress?: StayIndexProgress; period: PlacePeriod; selectedPlaceId?: string; onPeriodChange: (period: PlacePeriod) => void; onSelectPlace: (place: AllTimeStayPlace) => void }) {
  const [limit, setLimit] = useState(PLACE_LIST_PAGE);
  useEffect(() => setLimit(PLACE_LIST_PAGE), [period]);
  const dayCount = useMemo(() => new Set(stays?.map((stay) => dateKey(stay.startedAt))).size, [stays]);
  return <>
    <div className="all-places-header">
      <strong>滞在した場所</strong>
      <div className="segmented compact" role="tablist" aria-label="期間">
        {PLACE_PERIODS.map((option) => <button key={option.value} type="button" role="tab" aria-selected={period === option.value} className={period === option.value ? "active" : ""} onClick={() => onPeriodChange(option.value)}>{option.label}</button>)}
      </div>
    </div>
    <div className="day-summary">
      {!places || !stays
        ? <span className="all-places-status"><Spinner size={20}/><span>過去の記録を集計しています…{progress && progress.total > 0 ? ` ${progress.done}/${progress.total}日` : ""}</span></span>
        : places.length === 0
          ? <span className="day-summary-empty">この期間の滞在はありません</span>
          : <>
            <SummaryChip icon="place" tone="green" text={`${places.length}か所`}/>
            <SummaryChip icon="calendarMonth" tone="teal" text={`${dayCount}日`}/>
            <SummaryChip icon="restore" tone="amber" text={`滞在 ${stays.length}回`}/>
          </>}
    </div>
    {places && places.length > 0 && <>
      <div className="section-label-row all-places-label"><span>訪問回数の多い順</span><small>100m以内は同じ場所</small></div>
      <ul className="all-places-list">{places.slice(0, limit).map((place) => <li key={place.id}>
        <button type="button" className={`stay-place-row${place.id === selectedPlaceId ? " selected" : ""}`} onClick={() => onSelectPlace(place)} aria-label={`${coordinates(place)}の訪問履歴`}>
          <IconBadge name="place" tone="green"/>
          <div><strong>{coordinates(place)}</strong><small>{place.visits.length}回 · {place.dayCount}日 · 合計{activityDurationLabel(place.totalDurationMs)} · 最終 {formatDate(place.lastVisitedAt)}</small></div>
          <Icon name="chevronRight" className="stay-place-chevron"/>
        </button>
      </li>)}</ul>
      {places.length > limit && <button type="button" className="text-button all-places-more" onClick={() => setLimit((value) => value + PLACE_LIST_PAGE)}>さらに表示（残り{places.length - limit}か所）</button>}
    </>}
  </>;
}

function EmptyTimeline({ autoCapture }: { autoCapture: boolean }) {
  return <div className="empty-timeline">
    <IconBadge name="eventBusy" tone="neutral" size={56} iconSize={28}/>
    <strong>この日の記録はありません</strong>
    <p>{autoCapture ? "移動や滞在、撮影した写真がここに並びます。" : "設定で位置情報の記録をオンにすると、移動や滞在がここに並びます。"}</p>
  </div>;
}

type HomeMode = "day" | "all";

function ModeToggle({ mode, onChange }: { mode: HomeMode; onChange: (mode: HomeMode) => void }) {
  return <div className="mode-toggle" role="tablist" aria-label="地図の表示">
    <button type="button" role="tab" aria-selected={mode === "day"} className={mode === "day" ? "active" : ""} onClick={() => onChange("day")}>日ごと</button>
    <button type="button" role="tab" aria-selected={mode === "all"} className={mode === "all" ? "active" : ""} onClick={() => onChange("all")}>すべて</button>
  </div>;
}

function periodStart(period: PlacePeriod, now = Date.now()) {
  const days = PLACE_PERIODS.find((option) => option.value === period)?.days;
  return days === undefined ? undefined : new Date(now - days * 86_400_000).toISOString();
}

function TimelineHome({ events, stayIndex, previews, selectedDate, currentLocation, autoCapture, onDateChange, onSelectPhotos, onOpenSettings }: { events: LifeEvent[]; stayIndex: StayIndexState; previews: Map<string, string>; selectedDate: string; currentLocation?: CurrentLocation; autoCapture: boolean; onDateChange: (value: string) => void; onSelectPhotos: (photos: LifeEvent[]) => void; onOpenSettings: () => void }) {
  const dayEvents = useMemo(() => events.filter((event) => dateKey(event.startedAt) === selectedDate).sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [events, selectedDate]);
  const timeline = useMemo(() => buildTimelineSnapshot(dayEvents), [dayEvents]);
  const items = useMemo(() => buildSheetItems(timeline), [timeline]);
  const summary = useMemo(() => daySummary(timeline), [timeline]);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [mode, setMode] = useState<HomeMode>("day");
  const [period, setPeriod] = useState<PlacePeriod>("all");
  const [expanded, setExpanded] = useState(false);
  const [focus, setFocus] = useState<MapFocus>();
  const [historyPlace, setHistoryPlace] = useState<MapCoordinate>();
  const [selectedPlaceId, setSelectedPlaceId] = useState<string>();
  const [showPlaceHistory, setShowPlaceHistory] = useState(false);
  const sheetRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<number | undefined>(undefined);
  const periodStays = useMemo(() => {
    const from = periodStart(period);
    return from === undefined ? stayIndex.stays : stayIndex.stays?.filter((stay) => stay.startedAt >= from);
  }, [period, stayIndex.stays]);
  const places = useMemo(() => periodStays && buildAllTimeStayPlaces(periodStays), [periodStays]);
  const selectedPlace = places?.find((place) => place.id === selectedPlaceId);
  // A day's stay history reads the index once it is ready, so it matches the all-places map.
  const dayHistory = useMemo(() => {
    if (!historyPlace) return undefined;
    return stayIndex.stays ? stayVisitHistoryFromStays(stayIndex.stays, historyPlace) : buildStayVisitHistory(events, historyPlace);
  }, [events, historyPlace, stayIndex.stays]);

  useEffect(() => {
    setFocus(undefined);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [selectedDate]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [mode]);
  // Keep Leaflet's bottom controls (attribution) above the sheet, like Google Maps' padded logo.
  useEffect(() => {
    const sheet = sheetRef.current;
    const home = sheet?.parentElement;
    if (!sheet || !home) return;
    const update = () => home.style.setProperty("--sheet-inset", desktop ? "0px" : `${sheet.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [desktop]);
  // A collapsed sheet should always show the day header, not a mid-list row.
  useEffect(() => { if (!expanded) scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" }); }, [expanded]);

  const getInsets = useCallback((): MapInsets => {
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return { top: MAP_TOP_INSET, right: 0, bottom: 0, left: 0 };
    if (window.matchMedia(DESKTOP_QUERY).matches) return { top: MAP_TOP_INSET, right: 0, bottom: 0, left: rect.right };
    return { top: MAP_TOP_INSET, right: 0, bottom: Math.max(0, window.innerHeight - rect.top) + 20, left: 0 };
  }, []);

  function toggleFocus(activity: TimelineActivity) {
    setFocus((current) => current?.activityId === activity.id ? undefined : mapFocus(activity));
  }

  function selectPlace(place: AllTimeStayPlace) {
    setSelectedPlaceId(place.id);
    setShowPlaceHistory(true);
  }

  function openDay(day: string) {
    setHistoryPlace(undefined);
    setShowPlaceHistory(false);
    setMode("day");
    onDateChange(day);
  }

  return <section className={`timeline-home${desktop ? " desktop" : ""}`}>
    <LeafletMap timeline={timeline} previews={previews} viewKey={selectedDate} focus={focus} currentLocation={currentLocation} places={mode === "all" ? places ?? [] : undefined} selectedPlaceId={selectedPlaceId} getInsets={getInsets} onSelectPhotos={onSelectPhotos} onSelectPlace={selectPlace}/>
    <div className="map-controls map-controls-start">
      <div className="map-controls-row">
        <MapControlButton icon="settings" label="設定" onClick={onOpenSettings}/>
        <RecordingPill recording={autoCapture} onClick={onOpenSettings}/>
      </div>
      <ModeToggle mode={mode} onChange={setMode}/>
    </div>
    <section ref={sheetRef} className={`timeline-sheet${expanded || desktop ? " expanded" : ""}`} aria-label={mode === "all" ? "滞在した場所" : "この日の記録"}>
      {!desktop && <div
        className="sheet-drag"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={expanded ? "記録シートを閉じる" : "記録シートを開く"}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setExpanded((value) => !value); } }}
        onPointerDown={(event) => { dragStartRef.current = event.clientY; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerUp={(event) => {
          const start = dragStartRef.current;
          dragStartRef.current = undefined;
          if (start === undefined) return;
          const delta = event.clientY - start;
          setExpanded((value) => Math.abs(delta) < 8 ? !value : delta < 0);
        }}
      ><SheetHandle/></div>}
      <div ref={scrollRef} className="sheet-scroll">
        {mode === "all"
          ? <AllPlacesSheetContent places={places} stays={periodStays} progress={stayIndex.progress} period={period} selectedPlaceId={selectedPlaceId} onPeriodChange={setPeriod} onSelectPlace={(place) => { selectPlace(place); if (!desktop) setExpanded(false); }}/>
          : <>
            <DayHeader selectedDate={selectedDate} onDateChange={onDateChange}/>
            <div className="day-summary">
              {summary.distanceMeters < 1 && summary.stayCount === 0 && summary.mediaCount === 0
                ? <span className="day-summary-empty">記録はありません</span>
                : <>
                  {summary.distanceMeters >= 1 && <SummaryChip icon="route" tone="teal" text={formatDistance(summary.distanceMeters)}/>}
                  {summary.stayCount > 0 && <SummaryChip icon="place" tone="green" text={`滞在 ${summary.stayCount}`}/>}
                  {summary.mediaCount > 0 && <SummaryChip icon="photoCamera" tone="amber" text={String(summary.mediaCount)}/>}
                </>}
            </div>
            {items.length ? <>
              <div className="section-label-row"><span>タイムライン</span><small>{items.length}件</small></div>
              <ol className="timeline-list">{items.map((item, index) => item.kind === "activity"
                ? <ActivityRow key={item.id} activity={item.activity} isFirst={index === 0} isLast={index === items.length - 1} selected={focus?.activityId === item.id} previews={previews} onFocus={() => { toggleFocus(item.activity); if (!desktop) setExpanded(true); }} onSelectPhotos={onSelectPhotos} onOpenHistory={() => item.activity.kind === "stay" && setHistoryPlace({ latitude: item.activity.latitude, longitude: item.activity.longitude })}/>
                : <PhotoGroupRow key={item.id} entries={item.entries} isFirst={index === 0} isLast={index === items.length - 1} previews={previews} onOpen={() => onSelectPhotos(item.entries)}/>)}</ol>
            </> : <EmptyTimeline autoCapture={autoCapture}/>}
            {timeline.stayPlaces.length > 0 && <StayPlacesSection key={selectedDate} places={timeline.stayPlaces} onOpenHistory={(place) => setHistoryPlace({ latitude: place.latitude, longitude: place.longitude })}/>}
          </>}
      </div>
    </section>
    {mode === "day" && historyPlace && <PlaceHistorySheet history={dayHistory} place={historyPlace} onClose={() => setHistoryPlace(undefined)} onOpenDay={openDay}/>}
    {mode === "all" && showPlaceHistory && selectedPlace && <PlaceHistorySheet history={historyOf(selectedPlace.visits)} place={selectedPlace} onClose={() => setShowPlaceHistory(false)} onOpenDay={openDay}/>}
  </section>;
}

// ---- Photos ---------------------------------------------------------------

function PhotoListSheet({ photos, previews, onClose, onEditLocation }: { photos: LifeEvent[]; previews: Map<string, string>; onClose: () => void; onEditLocation: (photo: LifeEvent) => void }) {
  const [selectedPhoto, setSelectedPhoto] = useState<{ photo: LifeEvent; url?: string }>();
  const [remotePhotos, setRemotePhotos] = useState<Map<string, string[]>>(new Map());
  const sorted = useMemo(() => [...photos].sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [photos]);
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    void (async () => {
      for (const photo of sorted) {
        const blobs = await loadRemotePhotoPreviews(photo.id).catch(() => []);
        if (cancelled) break;
        const images = blobs.map((blob) => URL.createObjectURL(blob));
        urls.push(...images);
        setRemotePhotos((current) => new Map(current).set(photo.id, images));
      }
    })();
    return () => { cancelled = true; urls.forEach(URL.revokeObjectURL); };
  }, [sorted]);
  const first = formatTime(sorted[0].startedAt);
  const last = formatTime(sorted.at(-1)!.startedAt);
  useEscape(onClose);
  return <div className="scrim sheet-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-sheet" role="dialog" aria-modal="true" aria-label="写真と動画">
      <SheetHandle/>
      <header className="modal-sheet-header">
        <div><h2>写真と動画</h2><p>{mediaSummaryOf(sorted)} · {first === last ? first : `${first}–${last}`}</p></div>
        <IconButton icon="close" label="閉じる" onClick={onClose}/>
      </header>
      <div className="photo-grid">{sorted.flatMap((photo) => {
        const images = remotePhotos.get(photo.id) ?? [previews.get(photo.id)];
        return images.map((url, index) => <div className="photo-grid-tile" key={`${photo.id}:${index}`}>
          <PhotoThumb event={photo} preview={url} onClick={() => setSelectedPhoto({ photo, url })} large/>
          <span className="photo-grid-meta"><time>{formatTime(photo.startedAt)}</time>{index === 0 && photo.photoCount > 1 && <small>{photo.photoCount}</small>}</span>
        </div>);
      })}</div>
    </section>
    {selectedPhoto && <PhotoViewer photo={selectedPhoto.photo} imageUrl={selectedPhoto.url} onClose={() => setSelectedPhoto(undefined)} onEdit={() => { setSelectedPhoto(undefined); onEditLocation(selectedPhoto.photo); }}/>}
  </div>;
}

function PhotoViewer({ photo, imageUrl, onClose, onEdit }: { photo: LifeEvent; imageUrl?: string; onClose: () => void; onEdit: () => void }) {
  const isVideo = photo.mediaType === "video";
  useEscape(onClose);
  return <div className="photo-viewer" role="dialog" aria-modal="true" aria-label="メディアを拡大表示">
    {imageUrl
      ? <img src={imageUrl} alt={isVideo ? "選択した動画のサムネイル" : "選択した写真"}/>
      : <div className="photo-viewer-missing"><Icon name="imageNotSupported" size={40}/><strong>この端末に画像がありません</strong><span>撮影日時と位置の記録だけが残っています</span></div>}
    {isVideo && imageUrl && <Icon name="playCircle" size={56} className="photo-viewer-play"/>}
    <div className="photo-viewer-top">
      <IconButton icon="close" label="閉じる" onClick={onClose}/>
      <div><strong>{formatDayTime(photo.startedAt)}</strong><span>{eventMediaSummary(photo)}</span></div>
    </div>
    <div className="photo-viewer-bottom">
      <span>{coordinates(photo)}</span>
      <button type="button" className="tonal-button on-dark" onClick={onEdit}><Icon name="editLocationAlt" size={18}/>位置を補正</button>
    </div>
  </div>;
}

function LocationPicker({ value, onChange }: { value?: MapCoordinate; onChange: (value: MapCoordinate) => void }) {
  const elementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const map = L.map(element, { attributionControl: false, zoomControl: false, minZoom: 2, maxZoom: MAP_MAX_ZOOM }).setView(value ? [value.latitude, value.longitude] : DEFAULT_CENTER, value ? 16 : 11);
    L.tileLayer(TILE_URL, { maxZoom: MAP_MAX_ZOOM }).addTo(map);
    map.on("click", (event) => onChangeRef.current({ latitude: Number(event.latlng.lat.toFixed(6)), longitude: Number(event.latlng.lng.toFixed(6)) }));
    mapRef.current = map;
    window.setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; markerRef.current = null; };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!value) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) markerRef.current = L.circleMarker([value.latitude, value.longitude], { radius: 9, color: "#ffffff", weight: 3, fillColor: "#2f5a45", fillOpacity: 1, className: "picker-marker" }).addTo(map);
    else markerRef.current.setLatLng([value.latitude, value.longitude]);
    map.setView([value.latitude, value.longitude], Math.max(map.getZoom(), 16), { animate: true });
  }, [value]);
  return <div className="location-picker"><div className="location-picker-map" ref={elementRef} aria-label="補正後の写真位置を選ぶ地図"/><span className="location-picker-hint">地図をタップして位置を選択</span></div>;
}

function editableCoordinate(value?: number) { return value === undefined ? "" : value.toFixed(6); }

function locationSourceLabel(event: LifeEvent) {
  if (!hasUsableCoordinates(event)) return "位置情報なし";
  if (event.locationSource === "inferred") return "位置ログから補正済み";
  if (event.locationSource === "manual") return "手動で補正済み";
  return "撮影時の位置";
}

function formatSuggestionTime(value: number) {
  const minutes = Math.floor(value / 60_000);
  return minutes < 1 ? "1分以内" : `約${minutes}分以内`;
}

function formatSuggestionDistance(value?: number) {
  if (value === undefined) return "元の位置との距離は不明";
  return value < 1000 ? `元の位置から約${Math.floor(value)}m` : `元の位置から約${(value / 1000).toFixed(1)}km`;
}

function ActionRow({ icon, title, subtitle, danger = false, trailing, onClick, as = "button", children }: { icon: IconName; title: string; subtitle?: string; danger?: boolean; trailing?: ReactNode; onClick?: () => void; as?: "button" | "label" | "div"; children?: ReactNode }) {
  const content = <>
    <Icon name={icon} className="action-row-icon"/>
    <span className="action-row-text"><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
    {trailing}
    {children}
  </>;
  const className = `action-row${danger ? " danger" : ""}${onClick || as === "label" ? " interactive" : ""}`;
  if (as === "label") return <label className={className}>{content}</label>;
  if (as === "div" || !onClick) return <div className={className} onClick={onClick}>{content}</div>;
  return <button type="button" className={className} onClick={onClick}>{content}</button>;
}

function PhotoLocationScreen({ event, events, onClose, onUpdate, onDelete }: { event: LifeEvent; events: LifeEvent[]; onClose: () => void; onUpdate: (event: LifeEvent) => void; onDelete: () => void }) {
  const [latitudeText, setLatitudeText] = useState(editableCoordinate(event.latitude));
  const [longitudeText, setLongitudeText] = useState(editableCoordinate(event.longitude));
  const [showManualInput, setShowManualInput] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setLatitudeText(editableCoordinate(event.latitude));
    setLongitudeText(editableCoordinate(event.longitude));
  }, [event.id, event.latitude, event.longitude]);
  useEscape(onClose);
  const coordinate = useMemo(() => {
    const latitude = Number(latitudeText.trim());
    const longitude = Number(longitudeText.trim());
    return latitudeText.trim() && longitudeText.trim() && hasUsableCoordinates({ latitude, longitude }) ? { latitude, longitude } : undefined;
  }, [latitudeText, longitudeText]);
  const current = hasUsableCoordinates(event) ? { latitude: event.latitude, longitude: event.longitude } : undefined;
  const original = hasUsableCoordinates({ latitude: event.originalLatitude, longitude: event.originalLongitude }) ? { latitude: event.originalLatitude!, longitude: event.originalLongitude! } : undefined;
  const suggestion = useMemo(() => event.locationSource === "inferred" || event.photoLocationAutoPlacementDisabled === true ? undefined : suggestPhotoLocation(event, events), [event, events]);
  const changed = coordinate !== undefined && (!current || editableCoordinate(coordinate.latitude) !== editableCoordinate(current.latitude) || editableCoordinate(coordinate.longitude) !== editableCoordinate(current.longitude));

  function save(next: MapCoordinate | undefined, source: "exif" | "inferred" | "manual" | "removed") {
    const originalCoordinate = original ?? current;
    const updated: LifeEvent = {
      ...event,
      ...(originalCoordinate ? { originalLatitude: originalCoordinate.latitude, originalLongitude: originalCoordinate.longitude } : {}),
      locationSource: source,
      photoLocationAutoPlacementDisabled: source === "exif",
      updatedAt: new Date().toISOString(),
    };
    if (next) {
      updated.latitude = next.latitude;
      updated.longitude = next.longitude;
    } else {
      delete updated.latitude;
      delete updated.longitude;
    }
    onUpdate(updated);
  }

  return <div className="full-screen" role="dialog" aria-modal="true" aria-label="写真の位置">
    <header className="screen-header">
      <IconButton icon="close" label="閉じる" onClick={onClose}/>
      <div><h2>写真の位置</h2><p>{formatDayTime(event.startedAt)} · {eventMediaSummary(event)}</p></div>
    </header>
    <div className="screen-body">
      <div className="screen-column">
        <LocationPicker value={coordinate} onChange={(value) => { setLatitudeText(editableCoordinate(value.latitude)); setLongitudeText(editableCoordinate(value.longitude)); }}/>
        <div className="location-source">
          <strong>{locationSourceLabel(event)}</strong>
          <span>{coordinates(event)}</span>
          {original && (!current || editableCoordinate(original.latitude) !== editableCoordinate(current.latitude) || editableCoordinate(original.longitude) !== editableCoordinate(current.longitude)) && <small>撮影時の位置  {coordinates(original)}</small>}
        </div>
        {suggestion && <div className="suggestion-card">
          <Icon name="autoFixHigh" className="tint-green"/>
          <div><strong>位置ログから候補があります</strong><span>撮影の{formatSuggestionTime(suggestion.timeDistanceMs)} · {formatSuggestionDistance(suggestion.distanceFromOriginalMeters)}</span></div>
          <button type="button" className="text-button" onClick={() => {
            setLatitudeText(editableCoordinate(suggestion.latitude));
            setLongitudeText(editableCoordinate(suggestion.longitude));
            save(suggestion, "inferred");
          }}>適用</button>
        </div>}
        <div className="grouped-surface">
          <ActionRow icon={showManualInput ? "expandLess" : "expandMore"} title="緯度・経度を入力" onClick={() => setShowManualInput((value) => !value)}/>
          {showManualInput && <div className="coordinate-fields">
            <TextField label="緯度" inputMode="decimal" value={latitudeText} onChange={(input) => setLatitudeText(input.target.value)}/>
            <TextField label="経度" inputMode="decimal" value={longitudeText} onChange={(input) => setLongitudeText(input.target.value)}/>
            {!coordinate && (latitudeText.trim() || longitudeText.trim()) && <p className="field-error">緯度・経度を数値で入力してください</p>}
          </div>}
          {original && event.locationSource !== "exif" && <ActionRow icon="restore" title="撮影時の位置に戻す" onClick={() => {
            setLatitudeText(editableCoordinate(original.latitude));
            setLongitudeText(editableCoordinate(original.longitude));
            save(original, "exif");
          }}/>}
          {current && <ActionRow icon="locationOff" title="位置情報を削除" onClick={() => save(undefined, "removed")}/>}
          <ActionRow icon="deleteOutline" title="この写真の記録を削除" danger onClick={() => setConfirmDelete(true)}/>
        </div>
      </div>
    </div>
    <footer className="screen-footer"><button type="button" className="filled-button wide" disabled={!changed} onClick={() => save(coordinate, "manual")}>この位置で保存</button></footer>
    {confirmDelete && <ConfirmDeleteDialog title="この写真の記録を削除しますか？" message="Remoのタイムラインから削除します。端末の写真そのものは削除されません。" onDismiss={() => setConfirmDelete(false)} onConfirm={onDelete}/>}
  </div>;
}

function LocationRecordDialog({ event, onClose, onDelete }: { event: LifeEvent; onClose: () => void; onDelete: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (confirmDelete) return <ConfirmDeleteDialog title="この位置の記録を削除しますか？" message="この操作は元に戻せません。" onDismiss={() => setConfirmDelete(false)} onConfirm={onDelete}/>;
  return <Dialog title="位置の記録" onDismiss={onClose} actions={<>
    <button type="button" className="text-button danger" onClick={() => setConfirmDelete(true)}>削除</button>
    <button type="button" className="text-button" onClick={onClose}>閉じる</button>
  </>}><p className="dialog-strong">{formatDate(event.startedAt)} {formatTime(event.startedAt)}</p><p className="tabular">{coordinates(event)}</p></Dialog>;
}

// ---- Settings -------------------------------------------------------------

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-group"><h3>{title}</h3><div className="grouped-surface">{children}</div></section>;
}

const Chevron = () => <Icon name="chevronRight" size={20} className="chevron"/>;

function SettingsScreen({ user, captureEnabled, captureIssue, syncState, lastBackupAt, onBack, onToggleCapture, onAddPhotos, onExport, onImport, onDeleteAll, onBackup, onOpenAuth, onSignOut, onDeleteAccount }: {
  user?: { id: string; email: string };
  captureEnabled: boolean;
  captureIssue?: string;
  syncState: string;
  lastBackupAt?: string;
  onBack: () => void;
  onToggleCapture: () => void;
  onAddPhotos: (event: ChangeEvent<HTMLInputElement>) => void;
  onExport: () => void;
  onImport: (event: ChangeEvent<HTMLInputElement>) => void;
  onDeleteAll: () => void;
  onBackup: () => void;
  onOpenAuth: () => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
}) {
  useEscape(onBack);
  return <div className="settings-screen">
    <header className="top-app-bar"><IconButton icon="arrowBack" label="戻る" onClick={onBack}/><h1>設定</h1></header>
    <div className="settings-content">
      <SettingsGroup title="記録">
        <ActionRow icon="locationOn" title="位置情報の記録" subtitle={captureEnabled ? captureIssue ?? "移動中は10秒、静止時は5分ごとに記録（タブの表示中のみ）" : "停止中"} as="div" onClick={onToggleCapture} trailing={<Switch checked={captureEnabled} onChange={onToggleCapture} label="位置情報の記録"/>}/>
        <ActionRow icon="addPhotoAlternate" title="写真と動画を追加" subtitle="撮影日時と位置をタイムラインに表示します" as="label" trailing={<Chevron/>}><input type="file" accept="image/*,video/*" multiple hidden onChange={onAddPhotos}/></ActionRow>
      </SettingsGroup>
      {user ? <SettingsGroup title="バックアップ">
        <ActionRow icon={lastBackupAt ? "cloudDone" : "cloudUpload"} title={syncState} subtitle={lastBackupAt ? `最終バックアップ ${formatBackupTime(lastBackupAt)}` : "まだバックアップされていません"} trailing={<button type="button" className="text-button" onClick={onBackup}>今すぐ</button>}/>
        <ActionRow icon="person" title={user.email} subtitle="ログイン中"/>
        <ActionRow icon="logout" title="ログアウト" onClick={onSignOut}/>
      </SettingsGroup> : <section className="settings-group"><h3>バックアップ</h3><div className="grouped-surface backup-card">
        <div><Icon name="cloudUpload" className="tint-green"/><span><strong>クラウドにバックアップ</strong><small>ログインすると記録と写真の縮小画像をバックアップします。元写真と動画本体は含まれません。</small></span></div>
        <button type="button" className="filled-button wide" onClick={onOpenAuth}>ログイン・新規登録</button>
      </div></section>}
      <SettingsGroup title="データ">
        <ActionRow icon="iosShare" title="JSONをエクスポート" subtitle="期間を指定して位置と写真の情報を書き出します" trailing={<Chevron/>} onClick={onExport}/>
        <ActionRow icon="fileOpen" title="JSONをインポート" subtitle="書き出したファイルから記録を読み込みます" as="label" trailing={<Chevron/>}><input type="file" accept="application/json,.json" hidden onChange={onImport}/></ActionRow>
      </SettingsGroup>
      <SettingsGroup title="削除">
        <ActionRow icon="deleteOutline" title="すべての記録を削除" danger onClick={onDeleteAll}/>
        {user && <ActionRow icon="personRemove" title="アカウントを削除" danger onClick={onDeleteAccount}/>}
      </SettingsGroup>
      <p className="settings-footnote">Remo Web<br/>記録はこのブラウザに保存され、写真は外部に送信されません</p>
    </div>
  </div>;
}

function AccountDeletionDialog({ onDismiss, onDeleted }: { onDismiss: () => void; onDeleted: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  async function submit() {
    setDeleting(true);
    setError(undefined);
    let result: Awaited<ReturnType<typeof deleteAccount>>;
    try { result = await deleteAccount(password); } catch { result = "failed"; }
    setDeleting(false);
    if (result === "deleted") { onDeleted(); return; }
    setError(result === "invalid_password" ? "パスワードが正しくありません"
      : result === "rate_limited" ? "試行回数が多すぎます。しばらくしてから再度お試しください"
      : "アカウントを削除できませんでした。通信環境を確認してください");
  }
  const canSubmit = password.length > 0 && !deleting;
  return <Dialog icon="personRemove" iconTone="danger" title="アカウントを削除しますか？" onDismiss={() => { if (!deleting) onDismiss(); }} actions={<>
    <button type="button" className="text-button" disabled={deleting} onClick={onDismiss}>キャンセル</button>
    <button type="button" className="text-button danger" disabled={!canSubmit} onClick={() => void submit()}>{deleting ? "削除中…" : "削除する"}</button>
  </>}>
    <p>アカウントとクラウドのバックアップを削除します。この操作は元に戻せません。このブラウザの記録は残ります。</p>
    <form onSubmit={(event) => { event.preventDefault(); if (canSubmit) void submit(); }}><TextField label="パスワード" type="password" autoComplete="current-password" value={password} disabled={deleting} error={error} onChange={(event) => { setPassword(event.target.value); setError(undefined); }}/></form>
  </Dialog>;
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return <button type="button" className="date-field" aria-label={`${label}を変更`} onClick={() => { try { inputRef.current?.showPicker(); } catch { inputRef.current?.focus(); } }}>
    <span><small>{label}</small><strong>{formatDate(dayDate(value))}</strong></span>
    <Icon name="calendarMonth" size={20}/>
    <input ref={inputRef} type="date" tabIndex={-1} aria-hidden="true" value={value} max={dateKey(new Date())} onChange={(event) => event.target.value && onChange(event.target.value)}/>
  </button>;
}

function ExportRangeDialog({ events, range, onChange, onClose, onExport }: { events: LifeEvent[]; range: ExportRange; onChange: (range: ExportRange) => void; onClose: () => void; onExport: () => void }) {
  const selected = eventsInRange(events, range);
  const locationCount = selected.filter((event) => event.source !== "photo").length;
  const photoCount = selected.filter((event) => event.source === "photo").reduce((sum, event) => sum + event.photoCount, 0);
  const invalid = range.from > range.to;
  return <Dialog title="JSONをエクスポート" onDismiss={onClose} actions={<>
    <button type="button" className="text-button" onClick={onClose}>キャンセル</button>
    <button type="button" className="text-button" disabled={invalid} onClick={onExport}>書き出す</button>
  </>}>
    <div className="date-fields">
      <DateField label="開始日" value={range.from} onChange={(from) => onChange({ ...range, from })}/>
      <DateField label="終了日" value={range.to} onChange={(to) => onChange({ ...range, to })}/>
    </div>
    <p className={`export-summary${invalid ? " invalid" : ""}`}>{invalid ? "終了日は開始日以降にしてください" : `位置 ${locationCount}件 · 写真と動画 ${photoCount}件`}</p>
  </Dialog>;
}

// ---- Stay index -----------------------------------------------------------

type StayIndexProgress = { done: number; total: number };
type StayIndexState = { stays?: StaySummary[]; progress?: StayIndexProgress };

/** Continuous capture changes today's records every few seconds; batch those updates. */
const STAY_INDEX_DEBOUNCE_MS = 1000;

function currentTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Every stay across all days. Past days come from the device-local cache and
 * only days whose records changed are detected again; today is always fresh.
 */
function useStayIndex(storageId: string, events: LifeEvent[]): StayIndexState {
  const [state, setState] = useState<StayIndexState>({});
  const cacheRef = useRef<StayIndexCache | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const timeZone = currentTimeZone();
        let cache = cacheRef.current;
        if (!cache || cache.timeZone !== timeZone) {
          cache = parseStayIndexCache(await loadStayIndexCache(storageId), timeZone);
          if (controller.signal.aborted) return;
          cacheRef.current = cache;
        }
        const result = await updateStayIndex(events, cache, {
          today: dateKey(new Date()),
          signal: controller.signal,
          onProgress: (done, total) => setState((current) => ({ ...current, progress: { done, total } })),
        });
        if (!result) return;
        setState({ stays: result.stays });
        if (result.changed) void saveStayIndexCache(storageId, JSON.stringify(result.cache));
      })();
    }, cacheRef.current ? STAY_INDEX_DEBOUNCE_MS : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [events, storageId]);
  return state;
}

// ---- Home -----------------------------------------------------------------

function Home({ user, onOpenAuth }: { user?: { id: string; email: string }; onOpenAuth: () => void }) {
  const [storageId] = useState(() => prepareLocalStorage());
  const accountId = user?.id;
  const [lastBackupAt, setLastBackupAt] = useState<string>();
  const [syncState, setSyncState] = useState("バックアップ待ち");
  const [events, setEvents] = useState<LifeEvent[]>(() => loadEvents(storageId));
  const stayIndex = useStayIndex(storageId, events);
  const [selectedDate, setSelectedDate] = useState(() => dateKey(new Date()));
  const [selected, setSelected] = useState<{ event: LifeEvent }>();
  const [selectedPhotos, setSelectedPhotos] = useState<LifeEvent[]>();
  const [photoPreviews, setPhotoPreviews] = useState<Map<string, string>>(() => new Map());
  const [showSettings, setShowSettings] = useState(false);
  const [exportRange, setExportRange] = useState<ExportRange>(() => { const today = dateKey(new Date()); return { from: today, to: today }; });
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [showAccountDeletion, setShowAccountDeletion] = useState(false);
  const [captureEnabled, setCaptureEnabled] = useState(() => localStorage.getItem("remo:location-capture") !== "off");
  const [currentLocation, setCurrentLocation] = useState<CurrentLocation>();
  const [captureStatus, setCaptureStatus] = useState(CAPTURE_RUNNING_STATUS);
  const [photoStatus, setPhotoStatus] = useState<string>();
  const [storageStatus, setStorageStatus] = useState<string>();
  const captureModeRef = useRef<"normal" | "stationary">("normal");
  const locationHistoryRef = useRef<{ latitude: number; longitude: number; speedMps: number | null; accuracyMeters: number | null; receivedAt: number }[]>([]);
  const lastObservedLocationRef = useRef<{ latitude: number; longitude: number; speedMps: number | null; accuracyMeters: number | null; receivedAt: number } | undefined>(undefined);
  const lastAcceptedFixRef = useRef<{ timestamp: number; accuracyMeters: number } | undefined>(undefined);
  const lastLoggedRef = useRef<{ receivedAt: number; event: LifeEvent } | undefined>(undefined);
  const eventsRef = useRef(events);
  const syncInFlightRef = useRef(false);
  const lastSyncAttemptRef = useRef<{ accountId: string; at: number } | undefined>(undefined);
  const lastPullAtRef = useRef<{ accountId: string; at: number } | undefined>(undefined);
  const photoPreviewsRef = useRef(photoPreviews);

  useEffect(() => {
    setLastBackupAt(accountId ? localStorage.getItem(`remo:backup:last-success:${accountId}`) ?? undefined : undefined);
    setSyncState(accountId ? "バックアップ待ち" : "端末に保存済み");
  }, [accountId]);

  useEffect(() => () => { photoPreviewsRef.current.forEach((url) => URL.revokeObjectURL(url)); }, []);

  useEffect(() => {
    if (saveEvents(storageId, events)) {
      setStorageStatus(undefined);
      return;
    }
    // Keep the current in-memory timeline visible and stop adding records that
    // cannot be persisted. The user can export or clear data from Data Management.
    setStorageStatus("端末の保存容量がいっぱいです。データを出力してから不要な記録を削除してください。");
    setCaptureEnabled(false);
    setCaptureStatus("保存容量がいっぱいのため停止中");
  }, [events, storageId]);
  useEffect(() => { void migratePhotoPreviews(storageId); }, [storageId]);
  useEffect(() => { eventsRef.current = events; }, [events]);
  useEffect(() => {
    let cancelled = false;
    const missing = events.filter((event) => event.source === "photo" && !photoPreviewsRef.current.has(event.id));
    if (!missing.length) return;
    void Promise.all(missing.map(async (event) => {
      const blob = await loadPhotoPreview(storageId, event.id) ?? (accountId ? await loadRemotePhotoPreview(event.id).catch(() => undefined) : undefined);
      return blob ? { id: event.id, url: URL.createObjectURL(blob) } : undefined;
    })).then((loaded) => {
      const urls = loaded.flatMap((entry) => entry ? [entry] : []);
      if (cancelled) {
        urls.forEach(({ url }) => URL.revokeObjectURL(url));
        return;
      }
      const next = new Map(photoPreviewsRef.current);
      urls.forEach(({ id, url }) => {
        if (next.has(id)) URL.revokeObjectURL(url);
        else next.set(id, url);
      });
      photoPreviewsRef.current = next;
      setPhotoPreviews(next);
    });
    return () => { cancelled = true; };
  }, [events, storageId, accountId]);

  const syncNow = useCallback(async (force = false) => {
    if (!accountId) return;
    if (syncInFlightRef.current) return;
    const now = Date.now();
    const lastAttempt = lastSyncAttemptRef.current;
    if (!force && lastAttempt?.accountId === accountId && now - lastAttempt.at < 60_000) return;
    // The interval and visibilitychange listener can fire close together.
    // Keep the latest local state, but do not start another round-trip inside
    // the same minute just because the tab became visible again.
    lastSyncAttemptRef.current = { accountId, at: now };
    syncInFlightRef.current = true;
    setSyncState("バックアップ中…");
    try {
      const localAtStart = eventsRef.current;
      const lastPull = lastPullAtRef.current;
      const pull = force
        || lastPull?.accountId !== accountId
        || now - lastPull.at >= 2 * 60_000;
      const result = await synchronizeEvents(accountId, localAtStart, { pull });
      if (pull && result.online) lastPullAtRef.current = { accountId, at: Date.now() };
      // A location/photo can arrive while the network request is in flight.
      // Keep the newest local value so a refresh can never hide a live record.
      const merged = new Map(result.events.map((event) => [event.id, event]));
      const pendingDeleteIds = new Set(loadSyncQueue(accountId).filter((operation) => operation.kind === "delete").map((operation) => operation.eventId));
      const deletedIds = new Set([...result.deletedIds, ...pendingDeleteIds]);
      for (const id of deletedIds) merged.delete(id);
      const startedByID = new Map(localAtStart.map((event) => [event.id, event]));
      for (const local of eventsRef.current) {
        if (deletedIds.has(local.id)) continue;
        const remote = merged.get(local.id);
        if (remote && new Date(local.updatedAt).getTime() > new Date(remote.updatedAt).getTime()) merged.set(local.id, local);
        else if (!remote && !startedByID.has(local.id)) merged.set(local.id, local);
      }
      const nextEvents = [...merged.values()].sort(sortNewest);
      eventsRef.current = nextEvents;
      setEvents(nextEvents);
      let photoBackupPending = false;
      if (result.online) {
        const localPhotos = await listLocalPhotoPreviewIds(storageId);
        const pendingPhotos = nextEvents.filter((item) => item.source === "photo" && item.mediaType !== "video" && localPhotos.has(item.id) && !localStorage.getItem(`remo:photo-uploaded:${accountId}:${item.id}`));
        for (const event of pendingPhotos.slice(0, 20)) {
          const marker = `remo:photo-uploaded:${accountId}:${event.id}`;
          if (await uploadPhotoPreview(storageId, event.id).catch(() => false)) localStorage.setItem(marker, "1");
        }
        photoBackupPending = pendingPhotos.some((item) => !localStorage.getItem(`remo:photo-uploaded:${accountId}:${item.id}`));
      }
      if (result.online && result.pending === 0 && !photoBackupPending) {
        const completedAt = new Date().toISOString();
        localStorage.setItem(`remo:backup:last-success:${accountId}`, completedAt);
        setLastBackupAt(completedAt);
        setSyncState("バックアップ済み");
      } else {
        setSyncState("バックアップ待ち");
      }
    } catch {
      // The periodic and visibility-based retries handle temporary sync failures.
      setSyncState("オフライン · 端末に保存済み");
    } finally {
      syncInFlightRef.current = false;
    }
  }, [accountId, storageId]);

  useEffect(() => {
    void syncNow();
    const timer = window.setInterval(() => void syncNow(), 60_000);
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") void syncNow(); };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refreshWhenVisible); };
  }, [syncNow]);
  useEffect(() => {
    const refreshFromAnotherTab = () => setEvents(loadEvents(storageId));
    window.addEventListener("storage", refreshFromAnotherTab);
    return () => window.removeEventListener("storage", refreshFromAnotherTab);
  }, [storageId]);
  useEffect(() => {
    if (!captureEnabled || !navigator.geolocation) return;
    let cancelled = false;
    let sampleInFlight = false;
    let timer: number | undefined;

    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(sample, delayMs);
    };

    const sample = () => {
      if (sampleInFlight || cancelled || document.visibilityState !== "visible") return;
      sampleInFlight = true;
      navigator.geolocation.getCurrentPosition(({ coords, timestamp }) => {
        if (cancelled) { sampleInFlight = false; return; }
        const now = Date.now();
        const receivedAt = performance.now();
        const accuracyMeters = Number.isFinite(coords.accuracy) && coords.accuracy >= 0 ? coords.accuracy : null;
        if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)
          || coords.latitude < -90 || coords.latitude > 90 || coords.longitude < -180 || coords.longitude > 180
          || coords.latitude === 0 && coords.longitude === 0 || accuracyMeters !== null && accuracyMeters > 500) {
          sampleInFlight = false;
          setCaptureStatus("位置情報を取得できませんでした");
          scheduleNext(captureModeRef.current === "stationary" ? STATIONARY_INTERVAL_SECONDS * 1000 : NORMAL_INTERVAL_SECONDS * 1000);
          return;
        }
        const fixTimestamp = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : now;
        const lastFix = lastAcceptedFixRef.current;
        const sameFixWithBetterAccuracy = lastFix !== undefined && fixTimestamp === lastFix.timestamp
          && accuracyMeters !== null && accuracyMeters < lastFix.accuracyMeters;
        if (!sameFixWithBetterAccuracy && !isFreshFix(fixTimestamp, now, lastFix?.timestamp ?? 0)) {
          sampleInFlight = false;
          scheduleNext(captureModeRef.current === "stationary" ? STATIONARY_INTERVAL_SECONDS * 1000 : NORMAL_INTERVAL_SECONDS * 1000);
          return;
        }
        if (sameFixWithBetterAccuracy) {
          lastAcceptedFixRef.current = { timestamp: fixTimestamp, accuracyMeters: accuracyMeters! };
        } else {
          lastAcceptedFixRef.current = { timestamp: fixTimestamp, accuracyMeters: accuracyMeters ?? Number.POSITIVE_INFINITY };
        }
        const location = {
          latitude: coords.latitude,
          longitude: coords.longitude,
          ...(accuracyMeters !== null ? { accuracyMeters } : {}),
        };
        setCurrentLocation(location);

        const speed = Number.isFinite(coords.speed) && coords.speed !== null && coords.speed >= 0 ? coords.speed : null;
        const observed = {
          latitude: coords.latitude,
          longitude: coords.longitude,
          speedMps: speed,
          accuracyMeters,
          receivedAt,
        };
        const previous = lastObservedLocationRef.current;
        lastObservedLocationRef.current = sameFixWithBetterAccuracy ? previous : observed;

        if (!sameFixWithBetterAccuracy) locationHistoryRef.current.push(observed);
        const oldestAllowed = receivedAt - STATIONARY_HISTORY_WINDOW_MS;
        locationHistoryRef.current = locationHistoryRef.current.filter((item) => item.receivedAt >= oldestAllowed);

        const speedMoving = speed !== null && speed >= MOVEMENT_SPEED_MPS;
        const distanceMoving = previous ? distanceMeters(previous, observed) >= MOVEMENT_DISTANCE_M : false;
        const isMoving = speedMoving || distanceMoving;

        let nextMode = captureModeRef.current;
        if (isMoving) {
          if (captureModeRef.current === "stationary") {
            nextMode = "normal";
            captureModeRef.current = "normal";
          }
          locationHistoryRef.current = [observed];
          lastObservedLocationRef.current = observed;
        } else if (captureModeRef.current === "normal") {
          if (isStationary(locationHistoryRef.current, receivedAt)) {
            nextMode = "stationary";
            captureModeRef.current = "stationary";
          }
        }

        const lastLogged = lastLoggedRef.current;
        const intervalMs = (captureModeRef.current === "stationary" ? STATIONARY_INTERVAL_SECONDS : NORMAL_INTERVAL_SECONDS) * 1000;
        const withinInterval = lastLogged !== undefined && receivedAt - lastLogged.receivedAt < intervalMs;
        const improvesAccuracy = withinInterval && lastLogged.event.accuracyMeters !== undefined && accuracyMeters !== null
          && accuracyMeters < lastLogged.event.accuracyMeters * 0.75 && receivedAt - lastLogged.receivedAt <= 2_000;
        if (withinInterval && !improvesAccuracy && !sameFixWithBetterAccuracy) {
          sampleInFlight = false;
          setCaptureStatus("通常10秒／静止時5分で記録中");
          scheduleNext(nextMode === "stationary" ? STATIONARY_INTERVAL_SECONDS * 1000 : NORMAL_INTERVAL_SECONDS * 1000);
          return;
        }
        const event: LifeEvent = {
          id: withinInterval && lastLogged ? lastLogged.event.id : crypto.randomUUID(),
          startedAt: new Date(fixTimestamp).toISOString(),
          ...location,
          photoCount: 0,
          source: "location",
          updatedAt: new Date().toISOString(),
        };
        lastLoggedRef.current = { receivedAt: lastLogged?.receivedAt ?? receivedAt, event };
        setEvents((current) => [event, ...current].sort(sortNewest));
        if (accountId) enqueueSync(accountId, { id: crypto.randomUUID(), kind: "upsert", event });
        sampleInFlight = false;
        setCaptureStatus("通常10秒／静止時5分で記録中");
        scheduleNext(nextMode === "stationary" ? STATIONARY_INTERVAL_SECONDS * 1000 : NORMAL_INTERVAL_SECONDS * 1000);
      }, () => {
        sampleInFlight = false;
        if (!cancelled) setCaptureStatus("位置情報の権限を確認してください");
        scheduleNext(captureModeRef.current === "stationary" ? STATIONARY_INTERVAL_SECONDS * 1000 : NORMAL_INTERVAL_SECONDS * 1000);
      }, { enableHighAccuracy: false, maximumAge: 0, timeout: 15000 });
    };

    sample();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        if (timer) window.clearTimeout(timer);
        timer = undefined;
      } else {
        sample();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [captureEnabled, accountId]);
  useEffect(() => { if (!photoStatus) return; const timer = window.setTimeout(() => setPhotoStatus(undefined), 3000); return () => window.clearTimeout(timer); }, [photoStatus]);

  function openExport(range: ExportRange = { from: selectedDate, to: selectedDate }) {
    setExportRange(range);
    setShowExportDialog(true);
  }


  function exportSelectedRange() {
    downloadExport(storageId, events, exportRange);
    setShowExportDialog(false);
  }

  function toggleCapture() {
    const next = !captureEnabled;
    setCaptureEnabled(next);
    try {
      localStorage.setItem("remo:location-capture", next ? "on" : "off");
    } catch {
      // The preference is non-essential; the capture state still updates in memory.
    }
    setCaptureStatus(next ? "通常10秒／静止時5分で記録中" : "停止中");
    if (!next) {
      setCurrentLocation(undefined);
      captureModeRef.current = "normal";
      locationHistoryRef.current = [];
      lastObservedLocationRef.current = undefined;
      lastAcceptedFixRef.current = undefined;
      lastLoggedRef.current = undefined;
    }
  }
  async function addPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/"));
    if (!files.length) {
      event.target.value = "";
      setPhotoStatus("画像または動画を選択してください");
      return;
    }
    setPhotoStatus("写真を読み込み中…");
    const prepared = files.map((file) => {
      const id = crypto.randomUUID();
      const imageUrl = URL.createObjectURL(file);
      return { file, id, imageUrl, mediaType: file.type.startsWith("video/") ? "video" as const : "photo" as const };
    });
    const immediatePreviews = new Map(photoPreviewsRef.current);
    prepared.forEach(({ id, imageUrl }) => immediatePreviews.set(id, imageUrl));
    photoPreviewsRef.current = immediatePreviews;
    setPhotoPreviews(immediatePreviews);
    try {
      const importedWithPreviews = await Promise.all(prepared.map(async ({ file, id, imageUrl }) => {
        const metadata = await readPhotoMetadata(file);
        const startedAt = metadata?.takenAt ?? (file.lastModified > 0 ? new Date(file.lastModified).toISOString() : new Date().toISOString());
        const photoLocation = metadata && hasUsableCoordinates(metadata) ? { latitude: metadata.latitude, longitude: metadata.longitude, locationSource: "exif" as const } : undefined;
        const thumbnail = await makePhotoThumbnail(file);
        return { event: { id, startedAt, ...photoLocation, mediaType: file.type.startsWith("video/") ? "video" as const : "photo" as const, photoCount: 1, source: "photo", updatedAt: new Date().toISOString() } satisfies LifeEvent, file, imageUrl, thumbnail };
      }));
      const imported = importedWithPreviews.map(({ event: importedEvent }) => importedEvent);
      setEvents((current) => [...imported, ...current].sort(sortNewest));
      if (accountId) imported.forEach((item) => enqueueSync(accountId, { id: crypto.randomUUID(), kind: "upsert", event: item }));
      const nextPreviews = new Map(photoPreviewsRef.current);
      importedWithPreviews.forEach(({ event: importedEvent, file, imageUrl, thumbnail }) => {
        if (file.type.startsWith("video/")) {
          URL.revokeObjectURL(imageUrl);
          nextPreviews.set(importedEvent.id, URL.createObjectURL(thumbnail));
        }
        void savePhotoPreview(storageId, importedEvent.id, thumbnail);
      });
      photoPreviewsRef.current = nextPreviews;
      setPhotoPreviews(nextPreviews);
      const latest = imported.reduce((current, item) => item.startedAt > current.startedAt ? item : current);
      setSelectedDate(dateKey(latest.startedAt));
      const importedPhotoCount = imported.filter((item) => item.mediaType !== "video").length;
      const importedVideoCount = imported.filter((item) => item.mediaType === "video").length;
      setPhotoStatus(`${mediaSummary(importedPhotoCount, importedVideoCount)}を追加しました`);
    } catch {
      prepared.forEach(({ id, imageUrl }) => {
        URL.revokeObjectURL(imageUrl);
        photoPreviewsRef.current.delete(id);
      });
      setPhotoPreviews(new Map(photoPreviewsRef.current));
      setPhotoStatus("写真を読み込めませんでした");
    }
    event.target.value = "";
  }
  function remove(event: LifeEvent, relatedIds = [event.id]) {
    const ids = new Set(relatedIds);
    setEvents((current) => current.filter((item) => !ids.has(item.id)));
    ids.forEach((id) => { const url = photoPreviewsRef.current.get(id); if (url) URL.revokeObjectURL(url); photoPreviewsRef.current.delete(id); void deletePhotoPreview(storageId, id); });
    setPhotoPreviews(new Map(photoPreviewsRef.current));
    if (accountId) relatedIds.forEach((eventId) => enqueueSync(accountId, { id: crypto.randomUUID(), kind: "delete", eventId }));
    setSelected(undefined);
    setPhotoStatus("記録を削除しました");
  }
  function updateEvent(updated: LifeEvent) {
    setEvents((current) => current.map((event) => event.id === updated.id ? updated : event).sort(sortNewest));
    if (accountId) enqueueSync(accountId, { id: crypto.randomUUID(), kind: "upsert", event: updated });
    setSelected({ event: updated });
  }
  async function importFile(input: ChangeEvent<HTMLInputElement>) {
    const file = input.target.files?.[0];
    input.target.value = "";
    if (!file) return;
    try {
      const imported = await readImport(file);
      setEvents((current) => [...new Map([...current, ...imported].map((item) => [item.id, item])).values()].sort(sortNewest));
      if (accountId) imported.forEach((item) => enqueueSync(accountId, { id: crypto.randomUUID(), kind: "upsert", event: item }));
      const latest = imported.reduce<LifeEvent | undefined>((current, item) => !current || item.startedAt > current.startedAt ? item : current, undefined);
      if (latest) setSelectedDate(dateKey(latest.startedAt));
      setPhotoStatus(`${imported.length}件の記録を読み込みました`);
    } catch (error) {
      setPhotoStatus(error instanceof Error ? error.message : "インポートに失敗しました");
    }
  }
  async function removeAll() {
    if (accountId) {
      try { await deleteAllCloudData(); } catch { setPhotoStatus("クラウドに接続できないため削除できませんでした"); return; }
    }
    clearEvents(storageId, accountId);
    setEvents([]);
    void deleteAllPhotoPreviews(storageId);
    void deleteStayIndexCache(storageId);
    photoPreviewsRef.current.forEach((url) => URL.revokeObjectURL(url));
    photoPreviewsRef.current.clear();
    setPhotoPreviews(new Map());
    setStorageStatus(undefined);
    setPhotoStatus("すべての記録を削除しました");
  }
  const captureIssue = captureStatus !== CAPTURE_RUNNING_STATUS && captureStatus !== "停止中" ? captureStatus : undefined;
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const closePhotos = useCallback(() => setSelectedPhotos(undefined), []);

  return <div className="app">
    {showSettings
      ? <SettingsScreen
        user={user}
        captureEnabled={captureEnabled}
        captureIssue={captureIssue}
        syncState={syncState}
        lastBackupAt={lastBackupAt}
        onBack={closeSettings}
        onToggleCapture={toggleCapture}
        onAddPhotos={(event) => { setShowSettings(false); void addPhotos(event); }}
        onExport={() => openExport()}
        onImport={(event) => { setShowSettings(false); void importFile(event); }}
        onDeleteAll={() => setConfirmDeleteAll(true)}
        onBackup={() => void syncNow(true)}
        onOpenAuth={onOpenAuth}
        onSignOut={() => void authClient.signOut()}
        onDeleteAccount={() => setShowAccountDeletion(true)}
      />
      : <TimelineHome events={events} stayIndex={stayIndex} previews={photoPreviews} selectedDate={selectedDate} currentLocation={currentLocation} autoCapture={captureEnabled} onDateChange={setSelectedDate} onSelectPhotos={(photos) => { setSelected(undefined); setSelectedPhotos(photos); }} onOpenSettings={() => setShowSettings(true)}/>}
    <div className="snackbar-host" aria-live="polite">
      {storageStatus && <div className="snackbar" role="alert">{storageStatus}</div>}
      {photoStatus && <div className="snackbar" role="status">{photoStatus}</div>}
    </div>
    {selectedPhotos && <PhotoListSheet photos={selectedPhotos} previews={photoPreviews} onClose={closePhotos} onEditLocation={(photo) => { setSelectedPhotos(undefined); setSelected({ event: photo }); }}/>}
    {selected && (selected.event.source === "photo"
      ? <PhotoLocationScreen event={selected.event} events={events} onClose={() => setSelected(undefined)} onDelete={() => remove(selected.event)} onUpdate={updateEvent}/>
      : <LocationRecordDialog event={selected.event} onClose={() => setSelected(undefined)} onDelete={() => remove(selected.event)}/>)}
    {showExportDialog && <ExportRangeDialog events={events} range={exportRange} onChange={setExportRange} onClose={() => setShowExportDialog(false)} onExport={exportSelectedRange}/>}
    {confirmDeleteAll && <ConfirmDeleteDialog title="すべての記録を削除しますか？" message={accountId ? "このブラウザとクラウドのバックアップから、位置と写真の記録をすべて削除します。この操作は元に戻せません。" : "このブラウザから、位置と写真の記録をすべて削除します。この操作は元に戻せません。"} confirmLabel="すべて削除" onDismiss={() => setConfirmDeleteAll(false)} onConfirm={() => void removeAll()}/>}
    {showAccountDeletion && accountId && <AccountDeletionDialog onDismiss={() => setShowAccountDeletion(false)} onDeleted={() => {
      // The backup no longer exists, so nothing is left to upload or resume.
      clearSyncState(accountId);
      setShowAccountDeletion(false);
      setPhotoStatus("アカウントとクラウドのバックアップを削除しました");
      authClient.$store.notify("$sessionSignal");
    }}/>}
  </div>;
}

export function App() {
  const { data: session, isPending } = authClient.useSession();
  const [showAuth, setShowAuth] = useState(false);
  useEffect(() => {
    if (session) setShowAuth(false);
  }, [session]);
  const closeAuth = useCallback(() => setShowAuth(false), []);
  if (isPending) return <main className="loading-screen"><Spinner size={32}/></main>;
  // Auth sits on top so closing it returns to the same screen and day.
  return <>
    <Home key={session?.user.id ?? "device"} user={session ? { id: session.user.id, email: session.user.email } : undefined} onOpenAuth={() => setShowAuth(true)}/>
    {showAuth && !session && <AuthScreen onClose={closeAuth}/>}
  </>;
}
