// The web app's timeline algorithm (apps/web/src/timeline-map.ts), which the
// MCP tools run so that the stays and movements they report are the ones the
// app shows. Wrangler and Vitest resolve "@remo/timeline-map" to that file
// (`alias` in wrangler.jsonc and vitest.config.ts). The API type-checks
// against this declaration instead of the source, because the web code is
// written for the web compiler options (DOM, no noUncheckedIndexedAccess).
// Only the part the API uses is declared; keep it in step with the source.
declare module "@remo/timeline-map" {
  export type LifeEvent = {
    id: string;
    startedAt: string;
    latitude?: number;
    longitude?: number;
    originalLatitude?: number;
    originalLongitude?: number;
    locationSource?: "exif" | "inferred" | "manual" | "removed";
    photoLocationAutoPlacementDisabled?: boolean;
    accuracyMeters?: number;
    mediaType?: "photo" | "video";
    photoCount: number;
    source: "location" | "photo";
    updatedAt: string;
  };

  export type PlaceAnchor = { latitude: number; longitude: number; radiusMeters: number };

  export type NamedPlace = {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters?: number;
    anchors?: PlaceAnchor[];
    deleted?: boolean;
  };

  export type TimelineCorrection = {
    id: string;
    kind: "exclude" | "join_stay" | "not_stay";
    startedAt: number;
    endedAt: number;
    createdAt: number;
    source?: "app" | "mcp";
    deleted?: boolean;
  };

  export type TimelineAdjustments = { corrections?: TimelineCorrection[]; places?: NamedPlace[] };

  export type CorrectedLocation = {
    event: LifeEvent & { latitude: number; longitude: number };
    latitude: number;
    longitude: number;
    corrected: boolean;
  };

  export type StayCluster = {
    id: string;
    latitude: number;
    longitude: number;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    events: CorrectedLocation[];
    placeId?: string;
    corrected?: boolean;
  };

  export type TimelineAnalysis = {
    correctedPositions: CorrectedLocation[];
    correctedLocations: CorrectedLocation[];
    stayClusters: StayCluster[];
  };

  export type TimelineActivity =
    | {
      kind: "stay";
      id: string;
      startedAt: string;
      endedAt: string;
      durationMs: number;
      latitude: number;
      longitude: number;
      photos: LifeEvent[];
      placeId?: string;
      corrected?: boolean;
    }
    | {
      kind: "movement";
      id: string;
      startedAt: string;
      endedAt: string;
      durationMs: number;
      photos: LifeEvent[];
      distanceMeters: number;
      untrackedMs: number;
    };

  export type OutlierCandidate = {
    startedAt: number;
    endedAt: number;
    eventIds: string[];
    latitude: number;
    longitude: number;
    distanceMeters: number;
  };

  export const STAY_PLACE_RADIUS_METERS: number;
  export const MAX_CORRECTION_SPAN_MS: number;

  export function analyzeTimeline(events: LifeEvent[], adjustments?: TimelineAdjustments): TimelineAnalysis;

  export function buildTimelineActivities(events: LifeEvent[], analysis?: TimelineAnalysis): TimelineActivity[];

  export function buildTimelineSnapshot(events: LifeEvent[], adjustments?: TimelineAdjustments): TimelineAnalysis & { activities: TimelineActivity[] };

  export function findOutlierCandidates(analysis: TimelineAnalysis): OutlierCandidate[];

  export function withoutExcludedSamples(events: LifeEvent[], corrections: TimelineCorrection[] | undefined): LifeEvent[];

  export function placeAnchors(place: NamedPlace): PlaceAnchor[];

  export function matchPlace<P extends NamedPlace>(
    places: readonly P[] | undefined,
    point: { latitude: number; longitude: number },
  ): { place: P; anchor: PlaceAnchor; distanceMeters: number } | undefined;

  export function distanceMeters(
    from: { latitude: number; longitude: number },
    to: { latitude: number; longitude: number },
  ): number;
}
