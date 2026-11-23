import type { CSSProperties } from "react";
import { assetUrl } from "./catalog";
import "./agent-avatar.css";

import { attendantLabels, type AttendantState } from "./attendantState";

export function AgentAvatar({
  state,
  level = 0,
  compact = false,
}: {
  state: AttendantState;
  level?: number;
  compact?: boolean;
}) {
  const audible = state === "speaking";
  const open = audible && level > 0.06;
  const style = {
    "--avatar-atlas": `url("${assetUrl("agent/clerk-atlas.png")}")`,
    "--mouth-scale": String(0.4 + Math.min(1, level) * 0.6),
  } as CSSProperties;
  return (
    <div
      className={`agent-avatar ${compact ? "is-compact" : ""} ${audible ? "is-speaking" : ""}`}
      data-state={state}
      data-mouth={open ? "open" : "closed"}
      data-level={level.toFixed(2)}
      role="img"
      aria-label={`SWitch 점원 · ${attendantLabels[state]}`}
      style={style}
    >
      <div className="avatar-halo" />
      <div className="avatar-rig" aria-hidden="true">
        <div className="avatar-sprite avatar-body" />
        <div className="avatar-sprite avatar-arm-rest" />
        <div className="avatar-sprite avatar-arm-wave" />
        <div className="avatar-sprite avatar-blink" />
        <div
          className={`avatar-sprite avatar-mouth ${level > 0.55 ? "is-wide" : ""}`}
        />
      </div>
    </div>
  );
}
