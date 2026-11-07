import { useState } from "react";
import { createPortal } from "react-dom";
import { ArrowClockwise, CaretDown, CaretUp, CircleNotch, DownloadSimple, Pause, Play, RocketLaunch, X } from "@phosphor-icons/react";
import type { UpdateState, useAppUpdates } from "./updates";
import "./UpdateWidget.css";

type Props = ReturnType<typeof useAppUpdates> & { onInstall: () => void; hidden: boolean; installDisabled: boolean };
const title: Record<UpdateState["phase"], string> = {
  available: "New update available",
  downloading: "Downloading update…",
  paused: "Update paused",
  verifying: "Verifying update…",
  ready: "Ready to install",
  installing: "Installing update…",
  error: "Update failed",
};
function bytes(value: number) {
  return value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
}

export default function UpdateWidget({ update, stopping, download, pause, cancel, onInstall, hidden, installDisabled }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  if (!update || hidden) return null;
  const { phase, transfer, release } = update;
  const percent = transfer?.total ? Math.min(100, Math.round(transfer.received * 100 / transfer.total)) : null;
  const transferring = phase === "downloading" || phase === "verifying" || phase === "installing";

  if (collapsed) return createPortal(
    <button type="button" className="update-pill" onClick={() => setCollapsed(false)} aria-label="Expand update">
      {transferring && <CircleNotch size={13} className="update-spin" aria-hidden />}
      <span>{phase === "downloading" && percent !== null ? `Updating… ${percent}%` : phase === "ready" ? "Update ready" : title[phase]}</span>
      <CaretUp size={14} aria-hidden />
    </button>,
    document.body,
  );

  return createPortal(
    <aside className="update-card" aria-labelledby="update-title">
      <div className="update-head">
        <h2 id="update-title" role="status">{title[phase]} {phase === "available" && <span>{release.version}</span>}</h2>
        <button type="button" className="update-icon" onClick={() => setCollapsed(true)} aria-label="Collapse update"><CaretDown size={18} aria-hidden /></button>
      </div>
      <div className="update-body">
        {phase === "available" && <>
          <p>{release.mode === "installed" ? "A new version is available. With your approval, it downloads in the background." : "A new version is available on DevTune. Open the download page to update this portable copy."}</p>
          <div className="update-actions">
            <button type="button" className="update-button update-primary" onClick={download}><DownloadSimple size={14} aria-hidden />{release.mode === "installed" ? "Download" : "Open downloads"}</button>
          </div>
        </>}
        {(transferring || phase === "paused") && <>
          <div className="update-track" role="progressbar" aria-label={title[phase]} aria-valuenow={percent ?? undefined}>
            <span className={percent === null && phase !== "paused" ? "update-indeterminate" : ""} style={{ width: percent === null ? "33%" : `${Math.max(2, percent)}%` }} />
          </div>
          <div className="update-progress">
            <p>{phase === "paused" ? "Resume to restart the download." : phase === "downloading" && transfer?.total ? `${bytes(transfer.received)} / ${bytes(transfer.total)}` : title[phase]}</p>
            {(phase === "downloading" || phase === "paused") && <div className="update-actions">
              {phase === "downloading"
                ? <button type="button" className="update-icon" onClick={pause} disabled={stopping} aria-label="Pause download"><Pause size={15} aria-hidden /></button>
                : <button type="button" className="update-icon" onClick={download} disabled={stopping} aria-label="Resume download"><Play size={15} aria-hidden /></button>}
              <button type="button" className="update-icon" onClick={cancel} disabled={stopping} aria-label="Cancel update"><X size={15} aria-hidden /></button>
            </div>}
          </div>
        </>}
        {phase === "ready" && <>
          <p>Update {release.version} downloaded. PassWards will lock your vault, close to install, and reopen automatically.</p>
          <div className="update-actions">
            <button type="button" className="update-button" onClick={cancel} disabled={stopping}>Cancel</button>
            <button type="button" className="update-button update-primary" onClick={onInstall} disabled={stopping || installDisabled}><RocketLaunch size={14} aria-hidden />Install &amp; restart</button>
          </div>
        </>}
        {phase === "error" && <>
          <p className="update-error">{update.error}</p>
          <div className="update-actions">
            <button type="button" className="update-button" onClick={cancel} disabled={stopping}>Dismiss</button>
            <button type="button" className="update-button update-primary" onClick={download} disabled={stopping}><ArrowClockwise size={14} aria-hidden />Retry</button>
          </div>
        </>}
      </div>
    </aside>,
    document.body,
  );
}
