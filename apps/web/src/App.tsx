import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { authClient } from "./auth-client";
import { deleteAccount, deleteAllCloudData, synchronizeEvents } from "./life-api";
import { claimRecords, clearEvents, countUnsavedEvents, dateKey, downloadExport, ExportRange, ExportSummary, forgetAccount, lastBackupKey, LifeEvent, loadDayEvents, loadUploadedPhotos, localDeviceStorageId, migrateLegacyTimeline, Ownership, ownershipFor, Place, readImport, rememberUploadedPhoto, replaceRecords, storeImported, summarizeRange } from "./life-log";
import { clearDirtyDays, countEvents, deleteLocalEvents, listRecordedDays, loadDirtyDays, loadEvent, loadEventsInRange, loadStoredPlaces, putLocalEvents, putLocalPlace, requestPersistentStorage, storageUsage, StorageUsage } from "./timeline-db";
import { readPhotoMetadata } from "./photo-metadata";
import { deleteAllPhotoPreviews, deletePhotoPreview, listLocalPhotoPreviewIds, loadPhotoPreview, makePhotoThumbnail, migratePhotoPreviews, savePhotoPreview } from "./photo-storage";
import { loadRemotePhotoPreview, loadRemotePhotoPreviews, uploadPhotoPreview } from "./photo-api";
import { buildTimelineSnapshot, distanceMeters, PHOTO_LOCATION_SUGGESTION_WINDOW_MS, PhotoCluster, StayCluster, StayPlace, StayVisit, StayVisitHistory, STAY_PLACE_RADIUS_METERS, TimelineActivity, TimelineRenderSnapshot, UNTRACKED_GAP_MS, isMostlyUntracked, stayCircleRadiusMeters, suggestPhotoLocation } from "./timeline-map";
import { allStays, AllTimeStayPlace, buildAllTimeStayPlaces, detectDayStays, historyOf, parseStayIndexCache, refreshStayIndex, StayIndexCache, StaySummary, stayVisitHistoryFromStays } from "./stay-index";
import { deleteStayIndexCache, loadStayIndexCache, saveStayIndexCache } from "./stay-index-storage";
import { isFreshFix, isStationary } from "./capture-policy";
import { IconName } from "./icons";
import { activityDurationLabel, AppMark, ConfirmDeleteDialog, Dialog, dayDate, elapsedStayLabel, formatBackupTime, formatDate, formatDayTime, formatDayTitle, formatDistance, formatTime, Icon, IconBadge, IconButton, mediaSummary, SheetHandle, Spinner, Switch, TextField, useEscape, useModalFocus } from "./ui";

const NORMAL_INTERVAL_SECONDS = 10;
const STATIONARY_INTERVAL_SECONDS = 300; // 5 minutes
const STATIONARY_HISTORY_WINDOW_MS = 5 * 60 * 1000;
const MOVEMENT_DISTANCE_M = 75;
const MOVEMENT_SPEED_MPS = 1.2;
const CAPTURE_RUNNING_STATUS = "通常10秒／静止時5分で記録中";

// Map colors shared with apps/android TimelineMap.kt / RouteRenderPath.kt.
// The dark map needs lighter marks to keep the same contrast.
const MAP_COLORS = {
  light: { route: "rgb(14, 133, 119)", focusRoute: "rgb(8, 94, 84)", stay: "rgb(47, 90, 69)" },
  dark: { route: "rgb(88, 203, 185)", focusRoute: "rgb(160, 235, 222)", stay: "rgb(134, 211, 169)" },
};
const DARK_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_CENTER: [number, number] = [35.6812, 139.7671];
const MAP_MAX_ZOOM = 19;
// OpenStreetMap's own tile servers are for light use only; a production
// deployment sets VITE_MAP_TILE_URL (and its attribution) to a tile provider.
const TILE_URL = import.meta.env.VITE_MAP_TILE_URL || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = import.meta.env.VITE_MAP_TILE_ATTRIBUTION || "© OpenStreetMap";
/** Remote previews are fetched a few at a time so a day with many photos does not flood the API. */
const REMOTE_PREVIEW_CONCURRENCY = 4;

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

/** The name the user gave to the place at [coordinate], if there is one within the stay-place radius. */
function namedPlaceAt(places: Place[], coordinate: { latitude: number; longitude: number }): Place | undefined {
  let nearest: Place | undefined;
  let nearestDistance = STAY_PLACE_RADIUS_METERS;
  for (const place of places) {
    if (place.deleted) continue;
    const distance = distanceMeters(place, coordinate);
    if (distance <= nearestDistance) {
      nearest = place;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** A place's name, or its coordinate when it has none. */
function placeLabel(places: Place[], coordinate: { latitude: number; longitude: number }) {
  return namedPlaceAt(places, coordinate)?.name ?? coordinates(coordinate);
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
  const [notice, setNotice] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const modalRef = useModalFocus<HTMLElement>();
  useEscape(onClose);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage(undefined);
    setNotice(undefined);
    try {
      const result = signUp
        ? await authClient.signUp.email({ email, password, name: email.split("@")[0] || "Remo user" })
        : await authClient.signIn.email({ email, password });
      if (result.error) {
        // The server may require a confirmed address before the first sign-in.
        setMessage(result.error.code === "EMAIL_NOT_VERIFIED"
          ? "メールアドレスの確認が必要です。届いた確認メールのリンクを開いてから、もう一度ログインしてください。"
          : result.error.status === 429 ? "試行回数が多すぎます。しばらくしてから再度お試しください。"
          : result.error.message ?? "認証に失敗しました。");
      } else if (signUp && !(result.data as { token?: string | null } | null)?.token) {
        setSignUp(false);
        setNotice("確認メールを送信しました。メール内のリンクを開いてからログインしてください。");
      }
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

  return <main ref={modalRef} data-modal tabIndex={-1} className="auth-screen" role="dialog" aria-modal="true" aria-label="ログイン">
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
        {notice && <p className="notice-container" role="status"><Icon name="email" size={20}/><span>{notice}</span></p>}
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

function LeafletMap({ timeline, previews, viewKey, focus, currentLocation, places, placeNames, selectedPlaceId, getInsets, onSelectPhotos, onSelectPlace }: { timeline: TimelineRenderSnapshot; previews: Map<string, string>; viewKey: string; focus?: MapFocus; currentLocation?: CurrentLocation; places?: AllTimeStayPlace[]; placeNames: Place[]; selectedPlaceId?: string; getInsets: () => MapInsets; onSelectPhotos: (photos: LifeEvent[]) => void; onSelectPlace: (place: AllTimeStayPlace) => void }) {
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
  const { route: ROUTE_COLOR, focusRoute: FOCUS_ROUTE_COLOR, stay: STAY_COLOR } = MAP_COLORS[useMediaQuery(DARK_QUERY) ? "dark" : "light"];
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
    L.tileLayer(TILE_URL, { maxZoom: MAP_MAX_ZOOM, attribution: TILE_ATTRIBUTION }).addTo(map);
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
  }, [STAY_COLOR, places, ready, selectedPlaceId]);

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
    movementSegments.forEach((segment) => {
      // Nothing was recorded along this segment: it only connects two known points.
      const untracked = segment.gapMs >= UNTRACKED_GAP_MS;
      L.polyline([segment.from, segment.to], { color: ROUTE_COLOR, weight: untracked ? 2 : 4, dashArray: untracked ? "2 8" : undefined, opacity: dimmed ? segment.opacity * 0.2 : segment.opacity, lineCap: "round", lineJoin: "round", interactive: false }).addTo(layer);
    });
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
      circle.bindPopup(`<div class="map-popup"><strong>${escapeHtml(namedPlaceAt(placeNames, stay)?.name ?? "滞在")}</strong><span>${escapeHtml(formatTime(stay.startedAt))} – ${escapeHtml(formatTime(stay.endedAt))} · ${escapeHtml(elapsedStayLabel(stay.durationMs))}</span></div>`, { className: "remo-popup", closeButton: false });
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
  }, [FOCUS_ROUTE_COLOR, ROUTE_COLOR, STAY_COLOR, allPlaces, focus, movementSegments, photoClusters, placeNames, previews, ready, stayClusters]);

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

function ActivityRow({ activity, placeName, isFirst, isLast, selected, previews, onFocus, onSelectPhotos, onOpenHistory }: { activity: TimelineActivity; placeName?: string; isFirst: boolean; isLast: boolean; selected: boolean; previews: Map<string, string>; onFocus: () => void; onSelectPhotos: (photos: LifeEvent[]) => void; onOpenHistory: () => void }) {
  const stay = activity.kind === "stay";
  return <TimelineRow startedAt={activity.startedAt} endedAt={activity.endedAt} isFirst={isFirst} isLast={isLast} badge={stay ? <IconBadge name="place" tone="green"/> : <IconBadge name="route" tone="teal"/>}>
    <div className={`row-card ${activity.kind}${selected ? " selected" : ""}`} role="button" tabIndex={0} aria-pressed={selected} onClick={onFocus} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onFocus(); } }}>
      <RowTitle title={stay ? placeName ?? "滞在" : isMostlyUntracked(activity) ? "記録なし" : "移動"} trailing={activityDurationLabel(activity.durationMs)}/>
      {!stay && <span className="row-subtitle">{isMostlyUntracked(activity)
        ? `直線距離 ${formatDistance(activity.distanceMeters)}`
        : activity.untrackedMs > 0 ? `${formatDistance(activity.distanceMeters)}・うち記録なし ${activityDurationLabel(activity.untrackedMs)}` : formatDistance(activity.distanceMeters)}</span>}
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

function StayPlacesSection({ places, placeNames, onOpenHistory }: { places: StayPlace[]; placeNames: Place[]; onOpenHistory: (place: MapCoordinate) => void }) {
  const [expanded, setExpanded] = useState(false);
  const ordered = useMemo(() => [...places].sort((a, b) => b.visitCount - a.visitCount || b.totalDurationMs - a.totalDurationMs), [places]);
  return <section className="stay-places">
    <button type="button" className="stay-places-header" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <span><strong>滞在した場所</strong><small>{places.length}か所 · 100m以内の滞在は同じ場所にまとめています</small></span>
      <Icon name={expanded ? "expandLess" : "expandMore"}/>
    </button>
    {expanded && <ul>{ordered.map((place) => <li key={place.id}>
      <button type="button" className="stay-place-row" onClick={() => onOpenHistory(place)} aria-label={`${placeLabel(placeNames, place)}の訪問履歴`}>
        <IconBadge name="place" tone="green"/>
        <div><strong>{placeLabel(placeNames, place)}</strong><small>{place.visitCount}回 · 合計{activityDurationLabel(place.totalDurationMs)} · {place.visits.map((visit: StayCluster) => formatTime(visit.startedAt)).join(" / ")}</small></div>
        <Icon name="chevronRight" className="stay-place-chevron"/>
      </button>
    </li>)}</ul>}
  </section>;
}

/** Names a place, renames it, or removes its name. */
function PlaceNameDialog({ current, onDismiss, onSave }: { current?: Place; onDismiss: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(current?.name ?? "");
  const trimmed = name.trim();
  return <Dialog title={current ? "場所の名前を変更" : "場所に名前を付ける"} onDismiss={onDismiss} actions={<>
    {current && <button type="button" className="text-button danger" onClick={() => onSave("")}>名前を削除</button>}
    <button type="button" className="text-button" onClick={onDismiss}>キャンセル</button>
    <button type="button" className="text-button" disabled={!trimmed || trimmed === current?.name} onClick={() => onSave(trimmed)}>保存</button>
  </>}>
    <p>自宅や職場などの名前を付けると、座標の代わりに表示されます。ログイン中は他の端末にも同期されます。</p>
    <form onSubmit={(event) => { event.preventDefault(); if (trimmed && trimmed !== current?.name) onSave(trimmed); }}>
      <TextField label="名前" value={name} maxLength={80} onChange={(event) => setName(event.target.value)}/>
    </form>
  </Dialog>;
}

/** All-time visits to one place, grouped by day. Tapping a day opens it. */
function PlaceHistorySheet({ history, place, placeNames, onClose, onOpenDay, onRename }: { history?: StayVisitHistory; place: MapCoordinate; placeNames: Place[]; onClose: () => void; onOpenDay: (day: string) => void; onRename: (place: MapCoordinate, current: Place | undefined, name: string) => void }) {
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
  const named = namedPlaceAt(placeNames, place);
  const [naming, setNaming] = useState(false);
  const modalRef = useModalFocus<HTMLElement>();
  useEscape(onClose);
  return <div className="scrim sheet-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={modalRef} data-modal tabIndex={-1} className="modal-sheet" role="dialog" aria-modal="true" aria-label="訪問履歴">
      <SheetHandle/>
      <header className="modal-sheet-header">
        <div><h2>{named?.name ?? "訪問履歴"}</h2><p>{coordinates(place)} · 100m以内の滞在</p></div>
        <IconButton icon="edit" label={named ? "場所の名前を変更" : "場所に名前を付ける"} onClick={() => setNaming(true)}/>
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
    {naming && <PlaceNameDialog current={named} onDismiss={() => setNaming(false)} onSave={(name) => { setNaming(false); onRename(place, named, name); }}/>}
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
function AllPlacesSheetContent({ places, placeNames, stays, progress, period, selectedPlaceId, onPeriodChange, onSelectPlace }: { places?: AllTimeStayPlace[]; placeNames: Place[]; stays?: StaySummary[]; progress?: StayIndexProgress; period: PlacePeriod; selectedPlaceId?: string; onPeriodChange: (period: PlacePeriod) => void; onSelectPlace: (place: AllTimeStayPlace) => void }) {
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
        <button type="button" className={`stay-place-row${place.id === selectedPlaceId ? " selected" : ""}`} onClick={() => onSelectPlace(place)} aria-label={`${placeLabel(placeNames, place)}の訪問履歴`}>
          <IconBadge name="place" tone="green"/>
          <div><strong>{placeLabel(placeNames, place)}</strong><small>{place.visits.length}回 · {place.dayCount}日 · 合計{activityDurationLabel(place.totalDurationMs)} · 最終 {formatDate(place.lastVisitedAt)}</small></div>
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

function TimelineHome({ dayEvents, loadedDate, stayIndex, placeNames, previews, selectedDate, currentLocation, autoCapture, onDateChange, onSelectPhotos, onOpenSettings, onRenamePlace }: { dayEvents: LifeEvent[]; /** The day [dayEvents] belong to; it trails `selectedDate` while a day loads. */ loadedDate: string; stayIndex: StayIndexState; placeNames: Place[]; previews: Map<string, string>; selectedDate: string; currentLocation?: CurrentLocation; autoCapture: boolean; onDateChange: (value: string) => void; onSelectPhotos: (photos: LifeEvent[]) => void; onOpenSettings: () => void; onRenamePlace: (place: MapCoordinate, current: Place | undefined, name: string) => void }) {
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
  // A day's stay history is read from the index, so it matches the all-places
  // map; until the index is ready the sheet shows that it is being prepared.
  const dayHistory = useMemo(() => {
    if (!historyPlace || !stayIndex.stays) return undefined;
    return stayVisitHistoryFromStays(stayIndex.stays, historyPlace);
  }, [historyPlace, stayIndex.stays]);

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
    <LeafletMap timeline={timeline} previews={previews} viewKey={loadedDate} focus={focus} currentLocation={currentLocation} places={mode === "all" ? places ?? [] : undefined} placeNames={placeNames} selectedPlaceId={selectedPlaceId} getInsets={getInsets} onSelectPhotos={onSelectPhotos} onSelectPlace={selectPlace}/>
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
          ? <AllPlacesSheetContent places={places} placeNames={placeNames} stays={periodStays} progress={stayIndex.progress} period={period} selectedPlaceId={selectedPlaceId} onPeriodChange={setPeriod} onSelectPlace={(place) => { selectPlace(place); if (!desktop) setExpanded(false); }}/>
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
                ? <ActivityRow key={item.id} activity={item.activity} placeName={item.activity.kind === "stay" ? namedPlaceAt(placeNames, item.activity)?.name : undefined} isFirst={index === 0} isLast={index === items.length - 1} selected={focus?.activityId === item.id} previews={previews} onFocus={() => { toggleFocus(item.activity); if (!desktop) setExpanded(true); }} onSelectPhotos={onSelectPhotos} onOpenHistory={() => item.activity.kind === "stay" && setHistoryPlace({ latitude: item.activity.latitude, longitude: item.activity.longitude })}/>
                : <PhotoGroupRow key={item.id} entries={item.entries} isFirst={index === 0} isLast={index === items.length - 1} previews={previews} onOpen={() => onSelectPhotos(item.entries)}/>)}</ol>
            </> : <EmptyTimeline autoCapture={autoCapture}/>}
            {timeline.stayPlaces.length > 0 && <StayPlacesSection key={selectedDate} places={timeline.stayPlaces} placeNames={placeNames} onOpenHistory={(place) => setHistoryPlace({ latitude: place.latitude, longitude: place.longitude })}/>}
          </>}
      </div>
    </section>
    {mode === "day" && historyPlace && <PlaceHistorySheet history={dayHistory} place={historyPlace} placeNames={placeNames} onClose={() => setHistoryPlace(undefined)} onOpenDay={openDay} onRename={onRenamePlace}/>}
    {mode === "all" && showPlaceHistory && selectedPlace && <PlaceHistorySheet history={historyOf(selectedPlace.visits)} place={selectedPlace} placeNames={placeNames} onClose={() => setShowPlaceHistory(false)} onOpenDay={openDay} onRename={onRenamePlace}/>}
  </section>;
}

// ---- Photos ---------------------------------------------------------------

function PhotoListSheet({ photos, previews, signedIn, onClose, onEditLocation }: { photos: LifeEvent[]; previews: Map<string, string>; signedIn: boolean; onClose: () => void; onEditLocation: (photo: LifeEvent) => void }) {
  const [selectedPhoto, setSelectedPhoto] = useState<{ photo: LifeEvent; url?: string }>();
  const [remotePhotos, setRemotePhotos] = useState<Map<string, string[]>>(new Map());
  const sorted = useMemo(() => [...photos].sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [photos]);
  useEffect(() => {
    // Without an account there is no backup to read the other previews from.
    if (!signedIn) return;
    let cancelled = false;
    const urls: string[] = [];
    void (async () => {
      for (const photo of sorted) {
        // Videos have no backed-up preview.
        if (photo.mediaType === "video") continue;
        const blobs = await loadRemotePhotoPreviews(photo.id).catch(() => []);
        if (cancelled) break;
        const images = blobs.map((blob) => URL.createObjectURL(blob));
        urls.push(...images);
        setRemotePhotos((current) => new Map(current).set(photo.id, images));
      }
    })();
    return () => { cancelled = true; urls.forEach(URL.revokeObjectURL); };
  }, [signedIn, sorted]);
  const first = formatTime(sorted[0].startedAt);
  const last = formatTime(sorted.at(-1)!.startedAt);
  const modalRef = useModalFocus<HTMLElement>();
  useEscape(onClose);
  return <div className="scrim sheet-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={modalRef} data-modal tabIndex={-1} className="modal-sheet" role="dialog" aria-modal="true" aria-label="写真と動画">
      <SheetHandle/>
      <header className="modal-sheet-header">
        <div><h2>写真と動画</h2><p>{mediaSummaryOf(sorted)} · {first === last ? first : `${first}–${last}`}</p></div>
        <IconButton icon="close" label="閉じる" onClick={onClose}/>
      </header>
      <div className="photo-grid">{sorted.flatMap((photo) => {
        const remote = remotePhotos.get(photo.id);
        const images = remote?.length ? remote : [previews.get(photo.id)];
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
  const modalRef = useModalFocus<HTMLDivElement>();
  useEscape(onClose);
  return <div ref={modalRef} data-modal tabIndex={-1} className="photo-viewer" role="dialog" aria-modal="true" aria-label="メディアを拡大表示">
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
    const map = L.map(element, { attributionControl: true, zoomControl: false, minZoom: 2, maxZoom: MAP_MAX_ZOOM }).setView(value ? [value.latitude, value.longitude] : DEFAULT_CENTER, value ? 16 : 11);
    map.attributionControl.setPrefix(false);
    L.tileLayer(TILE_URL, { maxZoom: MAP_MAX_ZOOM, attribution: TILE_ATTRIBUTION }).addTo(map);
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
  const modalRef = useModalFocus<HTMLDivElement>();
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

  return <div ref={modalRef} data-modal tabIndex={-1} className="full-screen" role="dialog" aria-modal="true" aria-label="写真の位置">
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

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function storageSubtitle(usage: StorageUsage | undefined, eventCount: number) {
  const records = `${eventCount.toLocaleString("ja-JP")}件の記録`;
  if (!usage) return records;
  const used = `${records} · ${formatBytes(usage.usageBytes)} / ${formatBytes(usage.quotaBytes)}使用`;
  return usage.persisted ? used : `${used}（ブラウザが容量不足時に削除する可能性があります。エクスポートかバックアップをおすすめします）`;
}

function SettingsScreen({ user, captureEnabled, captureIssue, syncState, lastBackupAt, eventCount, storage, onBack, onToggleCapture, onAddPhotos, onExport, onImport, onDeleteAll, onBackup, onOpenAuth, onSignOut, onDeleteAccount }: {
  user?: { id: string; email: string };
  captureEnabled: boolean;
  captureIssue?: string;
  syncState: string;
  lastBackupAt?: string;
  eventCount: number;
  storage?: StorageUsage;
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
  const modalRef = useModalFocus<HTMLDivElement>();
  useEscape(onBack);
  return <div ref={modalRef} data-modal tabIndex={-1} className="settings-screen" role="dialog" aria-modal="true" aria-label="設定">
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
        <ActionRow icon="storage" title="このブラウザの保存容量" subtitle={storageSubtitle(storage, eventCount)}/>
        <ActionRow icon="iosShare" title="JSONをエクスポート" subtitle="期間を指定して位置と写真の情報を書き出します" trailing={<Chevron/>} onClick={onExport}/>
        <ActionRow icon="fileOpen" title="JSONをインポート" subtitle="書き出したファイルから記録を読み込みます" as="label" trailing={<Chevron/>}><input type="file" accept="application/json,.json" hidden onChange={onImport}/></ActionRow>
      </SettingsGroup>
      <SettingsGroup title="削除">
        <ActionRow icon="deleteOutline" title="すべての記録を削除" danger onClick={onDeleteAll}/>
        {user && <ActionRow icon="personRemove" title="アカウントを削除" danger onClick={onDeleteAccount}/>}
      </SettingsGroup>
      <p className="settings-footnote">Remo Web<br/>記録はこのブラウザに保存されます。ログイン中は、記録と写真の縮小画像をバックアップします</p>
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

function ExportRangeDialog({ storageId, range, exporting, onChange, onClose, onExport }: { storageId: string; range: ExportRange; exporting: boolean; onChange: (range: ExportRange) => void; onClose: () => void; onExport: () => void }) {
  const invalid = range.from > range.to;
  // Counted from storage a day at a time; the records are not kept in memory.
  const [summary, setSummary] = useState<ExportSummary>();
  useEffect(() => {
    setSummary(undefined);
    if (invalid) return;
    const controller = new AbortController();
    void summarizeRange(storageId, range, controller.signal).then((result) => { if (result) setSummary(result); }).catch(() => undefined);
    return () => controller.abort();
  }, [invalid, range, storageId]);
  return <Dialog title="JSONをエクスポート" onDismiss={onClose} actions={<>
    <button type="button" className="text-button" onClick={onClose}>キャンセル</button>
    <button type="button" className="text-button" disabled={invalid || exporting} onClick={onExport}>{exporting ? "書き出し中…" : "書き出す"}</button>
  </>}>
    <div className="date-fields">
      <DateField label="開始日" value={range.from} onChange={(from) => onChange({ ...range, from })}/>
      <DateField label="終了日" value={range.to} onChange={(to) => onChange({ ...range, to })}/>
    </div>
    <p className={`export-summary${invalid ? " invalid" : ""}`}>{invalid ? "終了日は開始日以降にしてください" : summary ? `位置 ${summary.locationCount}件 · 写真と動画 ${summary.photoCount}件` : "件数を確認しています…"}</p>
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
 * Every stay across all days. Past days come from the device-local cache; the
 * storage layer records which days had a record written or removed, and only
 * those are detected again. Today is always fresh. [revision] changes whenever
 * the stored records change.
 */
function useStayIndex(storageId: string, revision: number): StayIndexState {
  const [state, setState] = useState<StayIndexState>({});
  const cacheRef = useRef<StayIndexCache | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const timeZone = currentTimeZone();
        const today = dateKey(new Date());
        let cache = cacheRef.current;
        if (!cache || cache.timeZone !== timeZone) {
          cache = parseStayIndexCache(await loadStayIndexCache(storageId), timeZone).cache;
          if (controller.signal.aborted) return;
          cacheRef.current = cache;
        }
        const dirty = await loadDirtyDays(storageId);
        // The first pass covers every recorded day; an interrupted pass
        // continues with the days it has not reached.
        const days = cache.complete
          ? dirty.map((entry) => entry.day)
          : [...(await listRecordedDays(storageId)).filter((day) => !cache.days[day]), ...dirty.map((entry) => entry.day)];
        if (controller.signal.aborted) return;
        const result = await refreshStayIndex(cache, days, (day) => loadDayEvents(storageId, day), {
          today,
          signal: controller.signal,
          onProgress: (done, total) => setState((current) => ({ ...current, progress: { done, total } })),
        });
        const processed = new Set(result.processed);
        await clearDirtyDays(storageId, dirty.filter((entry) => processed.has(entry.day)));
        let changed = result.changed;
        if (!result.aborted && !cache.complete) {
          cache.complete = true;
          changed = true;
        }
        if (changed) void saveStayIndexCache(storageId, JSON.stringify(cache));
        if (result.aborted || controller.signal.aborted) return;
        // Today (and any record dated later) is detected on every update.
        const openDays = [...new Set([today, ...dirty.map((entry) => entry.day).filter((day) => day > today)])];
        const openStays = (await Promise.all(openDays.map(async (day) => detectDayStays(await loadDayEvents(storageId, day))))).flat();
        if (!controller.signal.aborted) setState({ stays: allStays(cache, openStays) });
      })().catch(() => undefined);
    }, cacheRef.current ? STAY_INDEX_DEBOUNCE_MS : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [revision, storageId]);
  return state;
}

// ---- Home -----------------------------------------------------------------

const SYNC_SESSION_EXPIRED = "再ログインが必要です";
const CAPTURE_PREFERENCE_KEY = "remo:location-capture";

function storedCapturePreference(): "on" | "off" | undefined {
  try {
    const value = localStorage.getItem(CAPTURE_PREFERENCE_KEY);
    return value === "on" || value === "off" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Shown before the browser's own permission prompt, so it does not appear without context. */
function LocationIntroDialog({ onStart, onLater }: { onStart: () => void; onLater: () => void }) {
  return <Dialog title="位置情報を記録しますか？" onDismiss={onLater} actions={<>
    <button type="button" className="text-button" onClick={onLater}>あとで</button>
    <button type="button" className="text-button" onClick={onStart}>記録を始める</button>
  </>}>
    <p>このタブを開いている間、現在地を記録して1日の移動と滞在を地図にまとめます。記録はこのブラウザに保存され、ログインしたときだけバックアップされます。</p>
    <p>次にブラウザが位置情報の許可を確認します。記録は設定からいつでも停止できます。</p>
  </Dialog>;
}

/** The records in this browser belong to another account than the one that signed in. */
function OwnershipDialog({ email, onMerge, onReplace, onSignOut }: { email: string; onMerge: () => void; onReplace: () => void; onSignOut: () => void }) {
  const [confirmReplace, setConfirmReplace] = useState(false);
  if (confirmReplace) {
    return <ConfirmDeleteDialog title="このブラウザの記録を削除しますか？" message="別のアカウントで使っていた記録をこのブラウザから削除し、ログインしたアカウントの記録を表示します。元のアカウントのバックアップは残ります。" confirmLabel="削除して切り替える" onDismiss={() => setConfirmReplace(false)} onConfirm={onReplace}/>;
  }
  return <Dialog title="別のアカウントの記録があります" onDismiss={onSignOut} actions={<>
    <button type="button" className="text-button" onClick={onSignOut}>ログアウト</button>
    <button type="button" className="text-button danger" onClick={() => setConfirmReplace(true)}>記録を削除して切り替える</button>
    <button type="button" className="text-button" onClick={onMerge}>このアカウントに保存</button>
  </>}>
    <p>このブラウザには、別のアカウントでバックアップしていた記録が残っています。{email} にログインしました。</p>
    <p>「このアカウントに保存」を選ぶと、残っている記録をこのアカウントにもバックアップします。自分の記録でない場合は選ばないでください。</p>
  </Dialog>;
}

/** On a shared computer the records should not stay behind after signing out. */
function SignOutDialog({ unsaved, onDismiss, onSignOut }: { unsaved: number; onDismiss: () => void; onSignOut: (removeRecords: boolean) => void }) {
  return <Dialog icon="logout" title="ログアウトしますか？" onDismiss={onDismiss} actions={<>
    <button type="button" className="text-button" onClick={onDismiss}>キャンセル</button>
    <button type="button" className="text-button danger" onClick={() => onSignOut(true)}>記録を削除してログアウト</button>
    <button type="button" className="text-button" onClick={() => onSignOut(false)}>ログアウト</button>
  </>}>
    <p>ログアウトしても、記録はこのブラウザに残り、誰でも見られます。共有のパソコンでは「記録を削除してログアウト」を選んでください。クラウドのバックアップは残ります。</p>
    {unsaved > 0 && <p className="dialog-strong">まだバックアップされていない記録が{unsaved.toLocaleString("ja-JP")}件あります。削除すると元に戻せません。</p>}
  </Dialog>;
}

function Home({ user, onOpenAuth }: { user?: { id: string; email: string }; onOpenAuth: () => void }) {
  const [storageId] = useState(() => localDeviceStorageId());
  const accountId = user?.id;
  const [lastBackupAt, setLastBackupAt] = useState<string>();
  const [syncState, setSyncState] = useState("バックアップ待ち");
  // Only the selected day is kept in memory; everything else is read from
  // IndexedDB when it is needed. `revision` changes whenever stored records do.
  const [dayRecords, setDayRecords] = useState<{ date: string; events: LifeEvent[] }>({ date: "", events: [] });
  const dayEvents = dayRecords.events;
  const [revision, setRevision] = useState(0);
  const [eventCount, setEventCount] = useState(0);
  const [placeNames, setPlaceNames] = useState<Place[]>([]);
  const [storage, setStorage] = useState<StorageUsage>();
  const stayIndex = useStayIndex(storageId, revision);
  const [selectedDate, setSelectedDate] = useState(() => dateKey(new Date()));
  const [selected, setSelected] = useState<{ event: LifeEvent }>();
  const [nearbyEvents, setNearbyEvents] = useState<LifeEvent[]>([]);
  const [selectedPhotos, setSelectedPhotos] = useState<LifeEvent[]>();
  const [photoPreviews, setPhotoPreviews] = useState<Map<string, string>>(() => new Map());
  const [showSettings, setShowSettings] = useState(false);
  const [exportRange, setExportRange] = useState<ExportRange>(() => { const today = dateKey(new Date()); return { from: today, to: today }; });
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [showAccountDeletion, setShowAccountDeletion] = useState(false);
  const [signOutRequest, setSignOutRequest] = useState<{ unsaved: number }>();
  // Recording is opt-out, but the browser is only asked after the user chose to start.
  const [capturePreference, setCapturePreference] = useState(storedCapturePreference);
  const captureEnabled = capturePreference === "on";
  const [ownership, setOwnership] = useState<Ownership>();
  const [currentLocation, setCurrentLocation] = useState<CurrentLocation>();
  const [captureStatus, setCaptureStatus] = useState(CAPTURE_RUNNING_STATUS);
  const [photoStatus, setPhotoStatus] = useState<string>();
  const [storageStatus, setStorageStatus] = useState<string>();
  const captureModeRef = useRef<"normal" | "stationary">("normal");
  const locationHistoryRef = useRef<{ latitude: number; longitude: number; speedMps: number | null; accuracyMeters: number | null; receivedAt: number }[]>([]);
  const lastObservedLocationRef = useRef<{ latitude: number; longitude: number; speedMps: number | null; accuracyMeters: number | null; receivedAt: number } | undefined>(undefined);
  const lastAcceptedFixRef = useRef<{ timestamp: number; accuracyMeters: number } | undefined>(undefined);
  const lastLoggedRef = useRef<{ receivedAt: number; event: LifeEvent } | undefined>(undefined);
  const syncInFlightRef = useRef(false);
  const lastSyncAttemptRef = useRef<{ accountId: string; at: number } | undefined>(undefined);
  const lastPullAtRef = useRef<{ accountId: string; at: number } | undefined>(undefined);
  const photoPreviewsRef = useRef(photoPreviews);
  const channelRef = useRef<BroadcastChannel | undefined>(undefined);

  function saveCapturePreference(next: "on" | "off") {
    setCapturePreference(next);
    try {
      localStorage.setItem(CAPTURE_PREFERENCE_KEY, next);
    } catch {
      // The preference is non-essential; the capture state still updates in memory.
    }
  }

  useEffect(() => {
    setLastBackupAt(accountId ? localStorage.getItem(lastBackupKey(accountId)) ?? undefined : undefined);
    setSyncState(accountId ? "バックアップ待ち" : "端末に保存済み");
  }, [accountId]);

  useEffect(() => () => { photoPreviewsRef.current.forEach((url) => URL.revokeObjectURL(url)); }, []);

  // Other tabs of this browser share the storage: tell them when it changed
  // and reload when they did.
  useEffect(() => {
    let channel: BroadcastChannel;
    try { channel = new BroadcastChannel(`remo-timeline:${storageId}`); } catch { return; }
    channelRef.current = channel;
    channel.onmessage = () => setRevision((value) => value + 1);
    return () => { channel.close(); channelRef.current = undefined; };
  }, [storageId]);

  /** Marks the stored records as changed: this tab reloads what it shows and other tabs are told. */
  const recordsChanged = useCallback(() => {
    setRevision((value) => value + 1);
    try { channelRef.current?.postMessage("changed"); } catch { /* single-tab browsers */ }
  }, []);

  /**
   * Runs a change to the stored records. When storage refuses the write,
   * recording stops rather than showing records that would be lost on reload.
   */
  const commit = useCallback(async (work: () => Promise<unknown>, fromCapture = false): Promise<boolean> => {
    try {
      await work();
      setStorageStatus(undefined);
      recordsChanged();
      return true;
    } catch {
      setStorageStatus("記録を保存できませんでした。保存容量がいっぱいの場合は、データを出力してから不要な記録を削除してください。");
      if (fromCapture) {
        setCapturePreference("off");
        setCaptureStatus("保存できないため停止中");
      }
      return false;
    }
  }, [recordsChanged]);

  useEffect(() => {
    void requestPersistentStorage();
    void migratePhotoPreviews(storageId);
    void migrateLegacyTimeline(storageId).then(recordsChanged).catch(() => undefined);
  }, [recordsChanged, storageId]);

  // The selected day.
  useEffect(() => {
    let cancelled = false;
    loadDayEvents(storageId, selectedDate).then((events) => {
      if (!cancelled) setDayRecords({ date: selectedDate, events });
    }).catch(() => {
      if (!cancelled) setStorageStatus("このブラウザでは記録を保存できません。プライベートブラウズやサイトデータのブロックを解除してください。");
    });
    return () => { cancelled = true; };
  }, [revision, selectedDate, storageId]);

  useEffect(() => {
    let cancelled = false;
    void loadStoredPlaces(storageId).then((places) => { if (!cancelled) setPlaceNames(places); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [revision, storageId]);

  useEffect(() => {
    if (!showSettings) return;
    void storageUsage().then(setStorage);
    void countEvents(storageId).then(setEventCount).catch(() => undefined);
  }, [revision, showSettings, storageId]);

  // Location samples near the photo being corrected: the suggestion reads the
  // track around the photo, which can cross midnight.
  const selectedPhoto = selected?.event.source === "photo" ? selected.event : undefined;
  const selectedPhotoTime = selectedPhoto?.startedAt;
  useEffect(() => {
    if (!selectedPhotoTime) { setNearbyEvents([]); return; }
    let cancelled = false;
    const time = Date.parse(selectedPhotoTime);
    const margin = PHOTO_LOCATION_SUGGESTION_WINDOW_MS * 4;
    void loadEventsInRange(storageId, time - margin, time + margin).then((events) => { if (!cancelled) setNearbyEvents(events); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [revision, selectedPhotoTime, storageId]);

  // Whose records these are. Records of another account are not uploaded
  // until the user says they should be.
  useEffect(() => {
    setOwnership(undefined);
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      let next = await ownershipFor(storageId, accountId);
      if (next === "unclaimed") {
        await claimRecords(storageId, accountId);
        next = "owned";
      }
      if (!cancelled) setOwnership(next);
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [accountId, storageId]);

  // Previews are loaded only for the photos on screen: the selected day and an
  // open photo list. Each record is tried once per account, including records
  // that have no preview (videos, photos never uploaded), so a new location
  // sample does not re-request every missing preview.
  const previewAttemptsRef = useRef<{ accountId?: string; ids: Set<string> }>({ ids: new Set() });
  const visiblePhotos = useMemo(() => {
    const visible = new Map<string, LifeEvent>();
    dayEvents.forEach((event) => { if (event.source === "photo") visible.set(event.id, event); });
    selectedPhotos?.forEach((event) => visible.set(event.id, event));
    return [...visible.values()];
  }, [dayEvents, selectedPhotos]);
  // A new location sample changes the day's records but not the photos on screen.
  const visiblePhotoKey = visiblePhotos.map((event) => `${event.id}:${event.mediaType ?? ""}`).join("|");
  const visiblePhotosRef = useRef(visiblePhotos);
  visiblePhotosRef.current = visiblePhotos;
  const previewAccountId = ownership === "owned" ? accountId : undefined;
  useEffect(() => {
    let cancelled = false;
    if (previewAttemptsRef.current.accountId !== previewAccountId) previewAttemptsRef.current = { accountId: previewAccountId, ids: new Set() };
    const attempted = previewAttemptsRef.current.ids;
    const missing = visiblePhotosRef.current.filter((event) => !photoPreviewsRef.current.has(event.id) && !attempted.has(event.id));
    if (!missing.length) return;
    missing.forEach((event) => attempted.add(event.id));
    const settled = new Set<string>();
    const publish = (loaded: { id: string; blob?: Blob }[]) => {
      if (cancelled) return;
      const next = new Map(photoPreviewsRef.current);
      loaded.forEach(({ id, blob }) => {
        settled.add(id);
        if (blob && !next.has(id)) next.set(id, URL.createObjectURL(blob));
      });
      photoPreviewsRef.current = next;
      setPhotoPreviews(next);
    };
    void (async () => {
      const localIds = await listLocalPhotoPreviewIds(storageId);
      publish(await Promise.all(missing.filter((event) => localIds.has(event.id))
        .map(async (event) => ({ id: event.id, blob: await loadPhotoPreview(storageId, event.id) }))));
      // Videos are never uploaded, so only photos are looked up in the cloud.
      const remote = missing.filter((event) => !localIds.has(event.id));
      if (!previewAccountId) { publish(remote.map((event) => ({ id: event.id }))); return; }
      publish(remote.filter((event) => event.mediaType === "video").map((event) => ({ id: event.id })));
      const photos = remote.filter((event) => event.mediaType !== "video");
      for (let index = 0; index < photos.length && !cancelled; index += REMOTE_PREVIEW_CONCURRENCY) {
        publish(await Promise.all(photos.slice(index, index + REMOTE_PREVIEW_CONCURRENCY)
          .map(async (event) => ({ id: event.id, blob: await loadRemotePhotoPreview(event.id).catch(() => undefined) }))));
      }
    })();
    return () => {
      cancelled = true;
      // Records not finished before cancellation are tried again next time.
      missing.forEach((event) => { if (!settled.has(event.id)) attempted.delete(event.id); });
    };
  }, [visiblePhotoKey, storageId, previewAccountId]);

  function forgetPreviews(ids: Iterable<string>) {
    for (const id of ids) {
      const url = photoPreviewsRef.current.get(id);
      if (url) URL.revokeObjectURL(url);
      photoPreviewsRef.current.delete(id);
      void deletePhotoPreview(storageId, id);
    }
    setPhotoPreviews(new Map(photoPreviewsRef.current));
  }

  const syncNow = useCallback(async (force = false) => {
    if (!accountId || ownership !== "owned") return;
    if (syncInFlightRef.current) return;
    const now = Date.now();
    const lastAttempt = lastSyncAttemptRef.current;
    if (!force && lastAttempt?.accountId === accountId && now - lastAttempt.at < 60_000) return;
    // The interval and visibilitychange listener can fire close together.
    // Do not start another round-trip inside the same minute just because
    // the tab became visible again.
    lastSyncAttemptRef.current = { accountId, at: now };
    syncInFlightRef.current = true;
    setSyncState("バックアップ中…");
    try {
      const lastPull = lastPullAtRef.current;
      const pull = force
        || lastPull?.accountId !== accountId
        || now - lastPull.at >= 2 * 60_000;
      const result = await synchronizeEvents(storageId, accountId, { pull });
      if (pull && result.online) lastPullAtRef.current = { accountId, at: Date.now() };
      if (result.removedIds.length) forgetPreviews(result.removedIds);
      if (result.changed) recordsChanged();
      if (result.unauthorized) {
        // The session ended (expired, or signed out everywhere): say so
        // instead of looking offline, and let the session state catch up.
        setSyncState(SYNC_SESSION_EXPIRED);
        setPhotoStatus("ログインの有効期限が切れました。設定からもう一度ログインしてください");
        authClient.$store.notify("$sessionSignal");
        return;
      }
      let photoBackupPending = false;
      if (result.online) {
        const localPhotos = await listLocalPhotoPreviewIds(storageId);
        const uploaded = await loadUploadedPhotos(accountId);
        const waiting = [...localPhotos].filter((id) => !uploaded.has(id));
        for (const id of waiting.slice(0, 20)) {
          const event = await loadEvent(storageId, id);
          // A preview without its record, or of a video, is never uploaded.
          if (!event || event.source !== "photo" || event.mediaType === "video") continue;
          if (await uploadPhotoPreview(storageId, id).catch(() => false)) await rememberUploadedPhoto(accountId, id);
          else photoBackupPending = true;
        }
        photoBackupPending ||= waiting.length > 20;
      }
      if (result.online && result.pending === 0 && !photoBackupPending) {
        const completedAt = new Date().toISOString();
        try { localStorage.setItem(lastBackupKey(accountId), completedAt); } catch { /* shown in memory */ }
        setLastBackupAt(completedAt);
        setSyncState("バックアップ済み");
      } else {
        setSyncState(result.online ? "バックアップ待ち" : "オフライン · 端末に保存済み");
      }
    } catch {
      // The periodic and visibility-based retries handle temporary sync failures.
      setSyncState("オフライン · 端末に保存済み");
    } finally {
      syncInFlightRef.current = false;
    }
  // forgetPreviews only touches refs and stable setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, ownership, recordsChanged, storageId]);

  useEffect(() => {
    void syncNow();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void syncNow(); }, 60_000);
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") void syncNow(); };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refreshWhenVisible); };
  }, [syncNow]);
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
        void commit(() => putLocalEvents(storageId, [event]), true);
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
  }, [captureEnabled, commit, storageId]);

  useEffect(() => { if (!photoStatus) return; const timer = window.setTimeout(() => setPhotoStatus(undefined), 4000); return () => window.clearTimeout(timer); }, [photoStatus]);

  function openExport(range: ExportRange = { from: selectedDate, to: selectedDate }) {
    setExportRange(range);
    setShowExportDialog(true);
  }

  async function exportSelectedRange() {
    setExporting(true);
    try {
      await downloadExport(storageId, exportRange);
      setShowExportDialog(false);
    } catch {
      setPhotoStatus("エクスポートに失敗しました");
    } finally {
      setExporting(false);
    }
  }

  function stopCapture() {
    saveCapturePreference("off");
    setCaptureStatus("停止中");
    setCurrentLocation(undefined);
    captureModeRef.current = "normal";
    locationHistoryRef.current = [];
    lastObservedLocationRef.current = undefined;
    lastAcceptedFixRef.current = undefined;
    lastLoggedRef.current = undefined;
  }

  function toggleCapture() {
    if (captureEnabled) {
      stopCapture();
    } else {
      saveCapturePreference("on");
      setCaptureStatus(CAPTURE_RUNNING_STATUS);
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
    const added: string[] = [];
    try {
      const imported: LifeEvent[] = [];
      const nextPreviews = new Map(photoPreviewsRef.current);
      // One file at a time: decoding many camera originals at once can exhaust memory.
      for (const file of files) {
        const id = crypto.randomUUID();
        const metadata = await readPhotoMetadata(file);
        const startedAt = metadata?.takenAt ?? (file.lastModified > 0 ? new Date(file.lastModified).toISOString() : new Date().toISOString());
        const photoLocation = metadata && hasUsableCoordinates(metadata) ? { latitude: metadata.latitude, longitude: metadata.longitude, locationSource: "exif" as const } : undefined;
        const thumbnail = await makePhotoThumbnail(file);
        imported.push({ id, startedAt, ...photoLocation, mediaType: file.type.startsWith("video/") ? "video" : "photo", photoCount: 1, source: "photo", updatedAt: new Date().toISOString() });
        // The thumbnail, not the original, is what stays on screen.
        nextPreviews.set(id, URL.createObjectURL(thumbnail));
        added.push(id);
        await savePhotoPreview(storageId, id, thumbnail);
      }
      photoPreviewsRef.current = nextPreviews;
      setPhotoPreviews(nextPreviews);
      if (!await commit(() => putLocalEvents(storageId, imported))) throw new Error("storage");
      const latest = imported.reduce((current, item) => item.startedAt > current.startedAt ? item : current);
      setSelectedDate(dateKey(latest.startedAt));
      const importedPhotoCount = imported.filter((item) => item.mediaType !== "video").length;
      const importedVideoCount = imported.filter((item) => item.mediaType === "video").length;
      setPhotoStatus(`${mediaSummary(importedPhotoCount, importedVideoCount)}を追加しました`);
      void syncNow(true);
    } catch {
      forgetPreviews(added);
      setPhotoStatus("写真を読み込めませんでした");
    }
    event.target.value = "";
  }

  async function remove(event: LifeEvent) {
    setSelected(undefined);
    if (!await commit(() => deleteLocalEvents(storageId, [event.id]))) return;
    forgetPreviews([event.id]);
    setPhotoStatus("記録を削除しました");
    void syncNow(true);
  }

  async function updateEvent(updated: LifeEvent) {
    setSelected({ event: updated });
    if (await commit(() => putLocalEvents(storageId, [updated]))) void syncNow(true);
  }

  async function renamePlace(coordinate: MapCoordinate, current: Place | undefined, name: string) {
    const place: Place = {
      id: current?.id ?? crypto.randomUUID(),
      name,
      latitude: current?.latitude ?? coordinate.latitude,
      longitude: current?.longitude ?? coordinate.longitude,
      updatedAt: Date.now(),
      deleted: name === "",
    };
    if (await commit(() => putLocalPlace(storageId, place))) void syncNow(true);
  }

  async function importFile(input: ChangeEvent<HTMLInputElement>) {
    const file = input.target.files?.[0];
    input.target.value = "";
    if (!file) return;
    setPhotoStatus("JSONを読み込み中…");
    try {
      const imported = await readImport(file);
      if (!await commit(() => storeImported(storageId, imported))) return;
      const latest = imported.reduce<LifeEvent | undefined>((current, item) => !current || item.startedAt > current.startedAt ? item : current, undefined);
      if (latest) setSelectedDate(dateKey(latest.startedAt));
      setPhotoStatus(`${imported.length}件の記録を読み込みました`);
      void syncNow(true);
    } catch (error) {
      setPhotoStatus(error instanceof Error ? error.message : "インポートに失敗しました");
    }
  }

  /** Removes everything this browser holds: records, previews and the derived stay index. */
  async function clearLocalRecords() {
    await clearEvents(storageId);
    await deleteAllPhotoPreviews(storageId);
    await deleteStayIndexCache(storageId);
    photoPreviewsRef.current.forEach((url) => URL.revokeObjectURL(url));
    photoPreviewsRef.current.clear();
    setPhotoPreviews(new Map());
    recordsChanged();
  }

  async function removeAll() {
    if (accountId && ownership === "owned") {
      try { await deleteAllCloudData(); } catch { setPhotoStatus("クラウドに接続できないため削除できませんでした"); return; }
    }
    // Recording stops with the deletion, as on Android and iOS: otherwise the
    // next sample would start a new timeline seconds after everything was removed.
    stopCapture();
    try {
      await clearLocalRecords();
      setStorageStatus(undefined);
      setPhotoStatus("すべての記録を削除し、位置情報の記録を停止しました");
    } catch {
      setPhotoStatus("記録を削除できませんでした");
    }
  }

  async function requestSignOut() {
    setSignOutRequest({ unsaved: await countUnsavedEvents(storageId).catch(() => 0) });
  }

  async function signOut(removeRecords: boolean) {
    setSignOutRequest(undefined);
    if (removeRecords) {
      stopCapture();
      await clearLocalRecords().catch(() => undefined);
    }
    await authClient.signOut();
    if (removeRecords) setPhotoStatus("このブラウザの記録を削除してログアウトしました");
  }

  async function resolveOwnership(mode: "merge" | "replace") {
    if (!accountId) return;
    if (mode === "replace") {
      await replaceRecords(storageId, accountId);
      await deleteAllPhotoPreviews(storageId);
      await deleteStayIndexCache(storageId);
      photoPreviewsRef.current.forEach((url) => URL.revokeObjectURL(url));
      photoPreviewsRef.current.clear();
      setPhotoPreviews(new Map());
      recordsChanged();
    } else {
      await claimRecords(storageId, accountId);
    }
    setOwnership("owned");
  }

  const syncAfterOwnershipRef = useRef(false);
  useEffect(() => {
    // The first backup right after the user decided whose records these are.
    if (ownership === "owned" && syncAfterOwnershipRef.current) { syncAfterOwnershipRef.current = false; void syncNow(true); }
  }, [ownership, syncNow]);

  const captureIssue = captureStatus !== CAPTURE_RUNNING_STATUS && captureStatus !== "停止中" ? captureStatus : undefined;
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const closePhotos = useCallback(() => setSelectedPhotos(undefined), []);
  const sessionExpired = syncState === SYNC_SESSION_EXPIRED;

  return <div className="app">
    {showSettings
      ? <SettingsScreen
        user={user}
        captureEnabled={captureEnabled}
        captureIssue={captureIssue}
        syncState={syncState}
        lastBackupAt={lastBackupAt}
        eventCount={eventCount}
        storage={storage}
        onBack={closeSettings}
        onToggleCapture={toggleCapture}
        onAddPhotos={(event) => { setShowSettings(false); void addPhotos(event); }}
        onExport={() => openExport()}
        onImport={(event) => { setShowSettings(false); void importFile(event); }}
        onDeleteAll={() => setConfirmDeleteAll(true)}
        onBackup={() => void syncNow(true)}
        onOpenAuth={onOpenAuth}
        onSignOut={() => void requestSignOut()}
        onDeleteAccount={() => setShowAccountDeletion(true)}
      />
      : <TimelineHome dayEvents={dayEvents} loadedDate={dayRecords.date} stayIndex={stayIndex} placeNames={placeNames} previews={photoPreviews} selectedDate={selectedDate} currentLocation={currentLocation} autoCapture={captureEnabled} onDateChange={setSelectedDate} onSelectPhotos={(photos) => { setSelected(undefined); setSelectedPhotos(photos); }} onOpenSettings={() => setShowSettings(true)} onRenamePlace={(place, current, name) => void renamePlace(place, current, name)}/>}
    <div className="snackbar-host" aria-live="polite">
      {storageStatus && <div className="snackbar" role="alert">{storageStatus}</div>}
      {photoStatus && <div className="snackbar" role="status">{photoStatus}</div>}
    </div>
    {selectedPhotos && <PhotoListSheet photos={selectedPhotos} previews={photoPreviews} signedIn={previewAccountId !== undefined && !sessionExpired} onClose={closePhotos} onEditLocation={(photo) => { setSelectedPhotos(undefined); setSelected({ event: photo }); }}/>}
    {selected && (selected.event.source === "photo"
      ? <PhotoLocationScreen event={selected.event} events={nearbyEvents} onClose={() => setSelected(undefined)} onDelete={() => void remove(selected.event)} onUpdate={(updated) => void updateEvent(updated)}/>
      : <LocationRecordDialog event={selected.event} onClose={() => setSelected(undefined)} onDelete={() => void remove(selected.event)}/>)}
    {showExportDialog && <ExportRangeDialog storageId={storageId} range={exportRange} exporting={exporting} onChange={setExportRange} onClose={() => setShowExportDialog(false)} onExport={() => void exportSelectedRange()}/>}
    {confirmDeleteAll && <ConfirmDeleteDialog title="すべての記録を削除しますか？" message={accountId && ownership === "owned" ? "このブラウザとクラウドのバックアップから、位置と写真の記録をすべて削除し、位置情報の記録を停止します。他の端末に保存されている記録は、その端末に残ります。この操作は元に戻せません。" : "このブラウザから、位置と写真の記録をすべて削除し、位置情報の記録を停止します。この操作は元に戻せません。"} confirmLabel="すべて削除" onDismiss={() => setConfirmDeleteAll(false)} onConfirm={() => void removeAll()}/>}
    {showAccountDeletion && accountId && <AccountDeletionDialog onDismiss={() => setShowAccountDeletion(false)} onDeleted={() => {
      // The backup no longer exists: the records here count as not backed up,
      // so a later account receives all of them.
      void forgetAccount(storageId, accountId);
      setShowAccountDeletion(false);
      setPhotoStatus("アカウントとクラウドのバックアップを削除しました");
      authClient.$store.notify("$sessionSignal");
    }}/>}
    {signOutRequest && <SignOutDialog unsaved={signOutRequest.unsaved} onDismiss={() => setSignOutRequest(undefined)} onSignOut={(removeRecords) => void signOut(removeRecords)}/>}
    {user && ownership === "other" && <OwnershipDialog
      email={user.email}
      onMerge={() => { syncAfterOwnershipRef.current = true; void resolveOwnership("merge"); }}
      onReplace={() => { syncAfterOwnershipRef.current = true; void resolveOwnership("replace"); }}
      onSignOut={() => void authClient.signOut()}
    />}
    {capturePreference === undefined && <LocationIntroDialog
      onStart={() => { saveCapturePreference("on"); setCaptureStatus(CAPTURE_RUNNING_STATUS); }}
      onLater={() => saveCapturePreference("off")}
    />}
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
