#!/usr/bin/env python3
"""Summarize a Remo JSON export: how the recording behaved and why.

    python3 tools/analyze-export.py remo-timeline-2026-10-01-2026-10-09.json

Prints, per local day, how many fixes were recorded, their accuracy and
spacing, and every hole in the record. When the export carries the Android
capture log (`diagnostics.captureLog`), it also prints how long the service
spent in each mode, the battery drain per mode, what ended each stay, why the
5-minute mode was not entered, and why the process was restarted. With the
per-fix journal (`diagnostics.fixLog`), it also prints what kinds of fixes
arrived and which of them jumped.
"""
import collections
import json
import math
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


def distance(a, b):
    """Meters between two (latitude, longitude) pairs; exact enough within a city."""
    x = math.radians(b[1] - a[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    return 6_371_000 * math.hypot(x, math.radians(b[0] - a[0]))


def report_flips(events):
    """Fixes that jump away and come straight back: two position sources disagreeing.

    One or two such fixes are repaired by the timeline; a longer run is drawn
    as a spike on the map, so the run length is what to look at.
    """
    fixes = sorted((parse(e["startedAt"]), (e["latitude"], e["longitude"])) for e in events
                   if e.get("source") == "location" and "latitude" in e and e.get("accuracyMeters", 0) <= 100)
    flips = collections.defaultdict(list)
    index = 1
    while index < len(fixes):
        (before_time, before), (time, position) = fixes[index - 1], fixes[index]
        seconds = (time - before_time).total_seconds()
        jump = distance(before, position)
        back = None
        if 0 < seconds <= 30 and jump >= 100 and jump / seconds >= 8:
            back = next((later for later in range(index + 1, len(fixes))
                         if (fixes[later][0] - time).total_seconds() <= 90 and distance(fixes[later][1], before) <= 50), None)
        if back is None:
            index += 1
            continue
        flips[time.date()].append(f"{time:%H:%M:%S} {jump:.0f}m×{back - index}")
        index = back
    print("\nposition flips (100m or more away and back within 90s; ×N is how many fixes stayed away):")
    for day, items in sorted(flips.items()):
        print(f"  {day}  {len(items):3d}  {', '.join(items[:8])}{' …' if len(items) > 8 else ''}")
    if not flips:
        print("  none")


def report_fix_log(fixes):
    """What the per-fix journal says about the fixes themselves."""
    print(f"\nfix journal: {len(fixes)} fixes")
    by_mode = collections.defaultdict(list)
    for fix in fixes:
        by_mode[fix.get("m", "?")].append(fix)

    def kind(fix):
        # A satellite fix reports how fast and where to the device moves; a network fix cannot.
        return "speed+bearing" if "spd" in fix and fix.get("brg") else "speed only" if "spd" in fix else "position only"

    for mode, items in sorted(by_mode.items()):
        delays = sorted(fix.get("delayMs", 0) for fix in items)
        print(f"  {mode:10s} {len(items):6d}  outcome: {top(collections.Counter(fix.get('r', '?') for fix in items))}")
        print(f"  {'':10s} {'':6s}  kind: {top(collections.Counter(map(kind, items)))}"
              f"  origin: {top(collections.Counter(fix.get('o', '?') for fix in items))}")
        print(f"  {'':10s} {'':6s}  delivery delay median {statistics.median(delays) / 1000:.1f}s, p90 {delays[int(len(delays) * 0.9)] / 1000:.1f}s")
    jumps = [fix for fix in fixes if fix.get("fromPrevM", 0) >= 80 and 0 < fix.get("sincePrevMs", 0) <= 30_000
             and fix["fromPrevM"] / (fix["sincePrevMs"] / 1000) >= 8]
    print(f"  jumps (80m or more from the fix before, faster than 8 m/s): {len(jumps)}")
    if jumps:
        print(f"  {'':2s}kind of the fix that jumped:  {top(collections.Counter(map(kind, jumps)))}")
        print(f"  {'':2s}what happened to it:          {top(collections.Counter(fix.get('r', '?') for fix in jumps))}")
        for fix in jumps[:12]:
            print(f"    {datetime.fromtimestamp(fix['t'] / 1000):%m-%d %H:%M:%S} {fix['fromPrevM']:.0f}m in {fix['sincePrevMs'] / 1000:.0f}s"
                  f"  accuracy {fix.get('acc', '?')}m  {kind(fix)}  {fix.get('o', '?')}  {fix.get('r', '?')}")


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
    step_runs = []
    power_save = collections.Counter()
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
            if mode == "stationary" and "stepRunMax" in entry:
                step_runs.append(entry["stepRunMax"])
            if entry.get("powerSave") or entry.get("locationPowerSave"):
                power_save[entry.get("locationPowerSave", "location unchanged")] += period
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
    if step_runs:
        # The run that ends a stay is 30 steps; how close stays came to it without walking away.
        ordered = sorted(step_runs)
        print(f"longest step run per 5-minute period: median {statistics.median(ordered)}, p90 {ordered[int(len(ordered) * 0.9)]}, max {ordered[-1]}")
    if power_save:
        print("battery saver on:         " + ", ".join(f"{name} {hours(ms)}" for name, ms in power_save.most_common()))
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
    report_flips(document.get("events", []))
    log = sorted(document.get("diagnostics", {}).get("captureLog", []), key=lambda entry: entry.get("t", 0))
    if not log:
        print("\nno capture log in this export (recorded before the diagnostics journal existed, or not on Android)")
        return
    print(f"\ncapture log: {len(log)} entries\nservice lifecycle:")
    report_capture_log(log)
    fixes = sorted(document.get("diagnostics", {}).get("fixLog", []), key=lambda entry: entry.get("t", 0))
    if fixes:
        report_fix_log(fixes)
    else:
        print("\nno fix journal in this export (recorded before it existed)")


if __name__ == "__main__":
    main()
