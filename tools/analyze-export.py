#!/usr/bin/env python3
"""Summarize a Remo JSON export: how the recording behaved and why.

    python3 tools/analyze-export.py remo-timeline-2026-10-01-2026-10-09.json

Prints, per local day, how many fixes were recorded, their accuracy and
spacing, and every hole in the record. When the export carries the Android
capture log (`diagnostics.captureLog`), it also prints how long the service
spent in each mode, the battery drain per mode, what ended each stay, why the
5-minute mode was not entered, and why the process was restarted.
"""
import collections
import json
import statistics
import sys
from datetime import datetime


def parse(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone()


def hours(ms):
    return f"{ms / 3_600_000:.1f}h"


def top(counter, limit=8):
    return ", ".join(f"{name}×{count}" for name, count in counter.most_common(limit)) or "-"


def report_fixes(events):
    fixes = sorted((parse(e["startedAt"]), e.get("accuracyMeters")) for e in events if e.get("source") == "location")
    if not fixes:
        print("no location fixes")
        return
    days = collections.defaultdict(list)
    for time, accuracy in fixes:
        days[time.date()].append((time, accuracy))
    print("day         fixes  accuracy median/p90  spacing median  longest hole")
    for day, items in sorted(days.items()):
        accuracy = sorted(a for _, a in items if a is not None) or [0]
        gaps = [(b[0] - a[0]).total_seconds() for a, b in zip(items, items[1:])] or [0]
        print(f"{day}  {len(items):5d}  {statistics.median(accuracy):6.0f}m /{accuracy[int(len(accuracy) * 0.9)]:5.0f}m"
              f"  {statistics.median(gaps):10.0f}s  {max(gaps) / 60:9.0f}min")
    print("\nholes longer than 15 minutes:")
    holes = [(a[0], b[0]) for a, b in zip(fixes, fixes[1:]) if (b[0] - a[0]).total_seconds() > 15 * 60]
    for start, end in holes:
        print(f"  {start:%m-%d %H:%M} → {end:%m-%d %H:%M}  ({(end - start).total_seconds() / 3600:.1f}h)")
    if not holes:
        print("  none")


def report_capture_log(log):
    time_in_mode = collections.Counter()
    drain = collections.defaultdict(lambda: [0.0, 0])  # mode -> [battery % lost, ms observed on battery]
    received = collections.Counter()
    logged = collections.Counter()
    dropped = collections.Counter()
    evidence = collections.Counter()
    signals = collections.Counter()
    returns = collections.Counter()
    stay_lengths = []
    late_wakeups = []
    previous_summary = None
    for entry in log:
        event = entry.get("e")
        if event == "summary":
            mode = entry.get("mode", "?")
            # A period without a single fix is a hole in the record, not time spent in the mode.
            period = entry.get("periodMs", 0)
            time_in_mode["no fixes" if period >= 5 * 60_000 and entry.get("received", 0) * 10 * 60_000 < period else mode] += period
            received[mode] += entry.get("received", 0)
            logged[mode] += entry.get("logged", 0)
            dropped.update(entry.get("dropped", {}))
            evidence.update(entry.get("evidence", {}))
            signals.update(entry.get("signals", {}))
            # Battery drain between two consecutive summaries of one mode, neither while charging.
            if (previous_summary and previous_summary.get("mode") == mode and not entry.get("charging")
                    and not previous_summary.get("charging") and "batteryPct" in entry and "batteryPct" in previous_summary
                    and entry["t"] - previous_summary["t"] < 20 * 60_000):
                drain[mode][0] += previous_summary["batteryPct"] - entry["batteryPct"]
                drain[mode][1] += entry["t"] - previous_summary["t"]
            previous_summary = entry
        elif event == "mode" and entry.get("to") == "normal":
            reason = entry.get("reason", "?")
            returns["left_anchor" if reason.startswith("left_anchor") else reason] += 1
            stay_lengths.append(entry.get("stationaryMs", 0))
        elif event == "first_fix_after_return":
            late_wakeups.append(entry.get("beyondAnchorM", 0))
        elif event in ("service_start", "service_restarted_by_system", "service_destroy", "task_removed", "location_request_failed", "activity_recognition_unavailable", "silent", "no_fix"):
            details = {k: v for k, v in entry.items() if k not in ("t", "e")}
            print(f"  {datetime.fromtimestamp(entry['t'] / 1000):%m-%d %H:%M:%S} {event} {json.dumps(details, ensure_ascii=False)}")

    total = sum(time_in_mode.values()) or 1
    print("\ntime per mode (from summaries):")
    for mode, ms in time_in_mode.most_common():
        lost, observed = drain[mode]
        rate = f"{lost / (observed / 3_600_000):.2f} %/h over {hours(observed)} on battery" if observed else "no battery data"
        print(f"  {mode:10s} {hours(ms):>7s} ({100 * ms / total:4.1f}%)  fixes received {received[mode]}, recorded {logged[mode]}  battery {rate}")
    print(f"\nfixes not recorded:       {top(dropped)}")
    print(f"stationary checks:        {top(evidence)}")
    print(f"movement signals:         {top(signals)}")
    print(f"what ended a stay:        {top(returns)}")
    if stay_lengths:
        print(f"5-minute mode periods:    {len(stay_lengths)}, median {statistics.median(stay_lengths) / 60_000:.0f}min, "
              f"shorter than 5min: {sum(length < 300_000 for length in stay_lengths)}")
    if late_wakeups:
        far = sum(distance > 150 for distance in late_wakeups)
        print(f"distance beyond the stay at the first fix after waking: median {statistics.median(late_wakeups):.0f}m, over 150m: {far}/{len(late_wakeups)}")


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with open(sys.argv[1], encoding="utf-8") as file:
        document = json.load(file)
    print(f"export {document.get('range')} written {document.get('exportedAt')}\n")
    report_fixes(document.get("events", []))
    log = sorted(document.get("diagnostics", {}).get("captureLog", []), key=lambda entry: entry.get("t", 0))
    if not log:
        print("\nno capture log in this export (recorded before the diagnostics journal existed, or not on Android)")
        return
    print(f"\ncapture log: {len(log)} entries\nservice lifecycle:")
    report_capture_log(log)


if __name__ == "__main__":
    main()
