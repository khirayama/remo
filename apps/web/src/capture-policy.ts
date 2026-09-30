export type CaptureSample = {
  receivedAt: number;
  latitude: number;
  longitude: number;
  speedMps: number | null;
  accuracyMeters: number | null;
};

const MAX_FIX_AGE_MS = 30_000;

function distanceMeters(first: CaptureSample, second: CaptureSample): number {
  const earthRadius = 6_371_000;
  const latitudeDelta = (second.latitude - first.latitude) * Math.PI / 180;
  const longitudeDelta = (second.longitude - first.longitude) * Math.PI / 180;
  const firstLatitude = first.latitude * Math.PI / 180;
  const secondLatitude = second.latitude * Math.PI / 180;
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.sin(longitudeDelta / 2) ** 2 * Math.cos(firstLatitude) * Math.cos(secondLatitude);
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function isFreshFix(fixTimestamp: number, nowTimestamp: number, lastFixTimestamp: number): boolean {
  return Number.isFinite(fixTimestamp)
    && fixTimestamp > lastFixTimestamp
    && nowTimestamp - fixTimestamp >= 0
    && nowTimestamp - fixTimestamp <= MAX_FIX_AGE_MS;
}

export function isStationary(
  samples: CaptureSample[],
  now: number,
  options: {
    historyWindowMs?: number;
    confirmationMs?: number;
    minSamples?: number;
    maxDisplacementMeters?: number;
    maxSpeedMps?: number;
  } = {},
): boolean {
  const historyWindowMs = options.historyWindowMs ?? 5 * 60 * 1000;
  const confirmationMs = options.confirmationMs ?? 3 * 60 * 1000;
  const minSamples = options.minSamples ?? 6;
  const maxDisplacementMeters = options.maxDisplacementMeters ?? 50;
  const maxSpeedMps = options.maxSpeedMps ?? 0.8;
  const recent = samples.filter((sample) => sample.receivedAt >= now - historyWindowMs);
  if (recent.length < minSamples) return false;
  if (now - recent.at(-1)!.receivedAt < 0 || now - recent.at(-1)!.receivedAt > MAX_FIX_AGE_MS) return false;
  if (recent.some((sample, index) => index > 0 && (sample.receivedAt - recent[index - 1].receivedAt <= 0 || sample.receivedAt - recent[index - 1].receivedAt > MAX_FIX_AGE_MS))) return false;
  if (recent.some((sample) => sample.accuracyMeters === null || !Number.isFinite(sample.accuracyMeters) || sample.accuracyMeters > 50)) return false;
  if (recent.at(-1)!.receivedAt - recent[0].receivedAt < confirmationMs) return false;
  const origin = recent[0];
  if (Math.max(...recent.map((sample) => distanceMeters(origin, sample))) > maxDisplacementMeters) return false;
  const speeds = recent.map((sample) => sample.speedMps).filter((speed): speed is number => speed !== null && Number.isFinite(speed) && speed >= 0);
  return speeds.length >= minSamples && Math.max(...speeds) <= maxSpeedMps;
}

