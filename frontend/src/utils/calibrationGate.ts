// enabled = 측정 표시 on/off (spec/decisions). Measurement must be gated on BOTH a saved
// homography AND enabled=true. A calibration can exist (homography present) while the user
// has toggled it off — in that case measurement stays disabled (finding #4). This is the
// single gate every measurement entrypoint (grid focus) runs its homography through.
export function measurableHomography(
  enabled: boolean,
  homography: number[][] | null,
): number[][] | null {
  return enabled ? homography : null;
}
