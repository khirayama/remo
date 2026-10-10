/**
 * Show what the timeline makes of a Remo JSON export, using the web app's own
 * timeline code.
 *
 *     just timeline-report remo-timeline-2026-10-01-2026-10-10.json
 *     just timeline-report remo-timeline-2026-10-01-2026-10-10.json 2026-10-10 11:20 11:40 out.svg
 *
 * The first form lists each day's stays and movements. A movement whose path
 * is much longer than the straight line between its ends, or has a long
 * single segment, is worth looking at. The second form also draws one time
 * window as an SVG: the recorded fixes in grey (orange: accuracy over 50m,
 * red: over 100m and not used) and the route the map draws on top of them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dateKey, LifeEvent } from "../apps/web/src/life-log";
import { buildTimelineSnapshot, distanceMeters, isMostlyUntracked, MAX_DISPLAY_ACCURACY_METERS, STAY_CLUSTER_RADIUS_METERS, TimelineRenderSnapshot, UNTRACKED_GAP_MS } from "../apps/web/src/timeline-map";

const [file, plotDay, plotFrom, plotTo, plotOutput] = process.argv.slice(2);
if (!file || (plotDay && !plotOutput)) {
  console.error("usage: timeline-report <export.json> [<day> <from HH:MM> <to HH:MM> <output.svg>]");
  process.exit(1);
}
const document = JSON.parse(readFileSync(file, "utf8")) as { events: LifeEvent[]; exportedAt: string };
const days = new Map<string, LifeEvent[]>();
for (const event of document.events) {
  const day = dateKey(event.startedAt);
  days.set(day, [...(days.get(day) ?? []), event]);
}
const clock = (value: string) => new Date(value).toTimeString().slice(0, 8);
const minutes = (ms: number) => `${Math.round(ms / 60_000)}min`.padStart(7);
const point = ([latitude, longitude]: [number, number]) => ({ latitude, longitude });

function report(day: string, snapshot: TimelineRenderSnapshot, eventCount: number) {
  const corrected = snapshot.correctedPositions.filter((location) => location.corrected).length;
  console.log(`\n${day}  records ${eventCount}, used ${snapshot.correctedPositions.length}, corrected ${corrected}, stays ${snapshot.stayClusters.length}`);
  for (const activity of snapshot.activities) {
    const time = `${clock(activity.startedAt)}-${clock(activity.endedAt)} ${minutes(activity.durationMs)}`;
    if (activity.kind === "stay") {
      const spread = activity.events.map((location) => distanceMeters(activity, location)).sort((a, b) => a - b);
      console.log(`  stay ${time}  ${activity.latitude.toFixed(5)},${activity.longitude.toFixed(5)}  fixes ${activity.events.length}`
        + `  from center: median ${spread[spread.length >> 1].toFixed(0)}m, max ${spread[spread.length - 1].toFixed(0)}m  photos ${activity.photos.length}`);
    } else {
      const longest = Math.max(...activity.path.slice(1).map((to, index) => distanceMeters(point(activity.path[index]), point(to))));
      console.log(`  move ${time}  path ${activity.distanceMeters.toFixed(0)}m, straight ${distanceMeters(point(activity.from), point(activity.to)).toFixed(0)}m`
        + `, longest segment ${longest.toFixed(0)}m, points ${activity.path.length}${isMostlyUntracked(activity) ? "  [not recorded]" : ""}  photos ${activity.photos.length}`);
    }
  }
}

function plot(day: string, events: LifeEvent[], snapshot: TimelineRenderSnapshot) {
  const from = new Date(`${day}T${plotFrom}:00`).getTime();
  const to = new Date(`${day}T${plotTo}:00`).getTime();
  const within = (value: string) => Date.parse(value) >= from && Date.parse(value) <= to;
  const fixes = events
    .filter((event) => event.source === "location" && typeof event.latitude === "number" && typeof event.longitude === "number" && within(event.startedAt))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt)) as (LifeEvent & { latitude: number; longitude: number })[];
  // The same points the map joins: everything outside a stay, plus each stay's last fix.
  const inStay = new Set(snapshot.stayClusters.flatMap((stay) => stay.events.map((location) => location.event.id)));
  const stayEnds = new Set(snapshot.stayClusters.map((stay) => stay.events[stay.events.length - 1].event.id));
  const route = snapshot.correctedPositions.filter((location) => within(location.event.startedAt) && (!inStay.has(location.event.id) || stayEnds.has(location.event.id)));
  const all = [...fixes, ...route];
  if (!all.length) return console.error(`nothing recorded on ${day} between ${plotFrom} and ${plotTo}`);

  const south = Math.min(...all.map((item) => item.latitude));
  const north = Math.max(...all.map((item) => item.latitude));
  const west = Math.min(...all.map((item) => item.longitude));
  const east = Math.max(...all.map((item) => item.longitude));
  const metersPerLongitude = 111_320 * Math.cos((south + north) / 2 * Math.PI / 180);
  const metersPerLatitude = 110_540;
  const size = 1400;
  const margin = 70;
  const scale = (size - 2 * margin) / Math.max(50, (east - west) * metersPerLongitude, (north - south) * metersPerLatitude);
  const x = (longitude: number) => (margin + (longitude - west) * metersPerLongitude * scale).toFixed(1);
  const y = (latitude: number) => (size - margin - (latitude - south) * metersPerLatitude * scale).toFixed(1);
  const used = fixes.filter((fix) => (fix.accuracyMeters ?? 0) <= MAX_DISPLAY_ACCURACY_METERS);

  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" font-family="sans-serif"><rect width="100%" height="100%" fill="white"/>`];
  svg.push(`<polyline fill="none" stroke="#bbb" points="${used.map((fix) => `${x(fix.longitude)},${y(fix.latitude)}`).join(" ")}"/>`);
  for (const fix of fixes) {
    const accuracy = fix.accuracyMeters ?? 0;
    svg.push(`<circle cx="${x(fix.longitude)}" cy="${y(fix.latitude)}" r="2.5" fill="${accuracy > MAX_DISPLAY_ACCURACY_METERS ? "#e33" : accuracy > 50 ? "#f90" : "#888"}" opacity="0.7"/>`);
  }
  for (const stay of snapshot.stayClusters) {
    if (Date.parse(stay.endedAt) < from || Date.parse(stay.startedAt) > to) continue;
    svg.push(`<circle cx="${x(stay.longitude)}" cy="${y(stay.latitude)}" r="${STAY_CLUSTER_RADIUS_METERS * scale}" fill="#36c" fill-opacity="0.08" stroke="#36c" stroke-dasharray="4 4"/>`
      + `<circle cx="${x(stay.longitude)}" cy="${y(stay.latitude)}" r="6" fill="#36c"/>`
      + `<text x="${Number(x(stay.longitude)) + 10}" y="${Number(y(stay.latitude)) - 10}" font-size="15" fill="#136">${clock(stay.startedAt).slice(0, 5)}-${clock(stay.endedAt).slice(0, 5)}</text>`);
  }
  route.slice(1).forEach((location, index) => {
    const previous = route[index];
    const untracked = Date.parse(location.event.startedAt) - Date.parse(previous.event.startedAt) >= UNTRACKED_GAP_MS;
    svg.push(`<line x1="${x(previous.longitude)}" y1="${y(previous.latitude)}" x2="${x(location.longitude)}" y2="${y(location.latitude)}" stroke="#0E8577" stroke-linecap="round" opacity="0.85" `
      + `${untracked ? 'stroke-width="1.5" stroke-dasharray="3 8"' : 'stroke-width="3"'}/>`);
  });
  route.forEach((location, index) => {
    if (index % 12 === 0) svg.push(`<text x="${Number(x(location.longitude)) + 5}" y="${Number(y(location.latitude)) + 14}" font-size="12" fill="#064">${clock(location.event.startedAt).slice(0, 5)}</text>`);
  });
  const bar = [50, 100, 200, 500, 1000, 2000, 5000, 20_000].find((meters) => meters * scale > 100) ?? 20_000;
  svg.push(`<line x1="${margin}" y1="${size - 24}" x2="${margin + bar * scale}" y2="${size - 24}" stroke="black" stroke-width="3"/>`
    + `<text x="${margin}" y="${size - 32}" font-size="15">${bar}m · ${day} ${plotFrom}-${plotTo} · grey: recorded fixes · green: drawn route · blue: stays</text></svg>`);
  writeFileSync(plotOutput, svg.join("\n"));
  console.log(`\nwrote ${plotOutput}: ${fixes.length} fixes, ${route.length} route points`);
}

for (const [day, events] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
  if (plotDay && day !== plotDay) continue;
  const snapshot = buildTimelineSnapshot(events, Date.parse(document.exportedAt));
  report(day, snapshot, events.length);
  if (plotDay) plot(day, events, snapshot);
}
