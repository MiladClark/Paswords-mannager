import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { call, native } from "./api";

type Availability = { version: string | null; mode: "installed" | "portable" | "manual" };
export type Transfer = { received: number; total: number | null; verifying: boolean };
type Phase = "available" | "downloading" | "paused" | "verifying" | "ready" | "installing" | "error";
export type UpdateState = { phase: Phase; release: Availability; transfer?: Transfer; error?: string };

export function useAppUpdates() {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState("");
  const [stopping, setStopping] = useState(false);
  const activity = useRef<"check" | "download" | "install" | null>(null);
  const stop = useRef<"pause" | "cancel" | null>(null);

  async function check(manual: boolean) {
    if (!native || activity.current || update?.phase === "ready" || update?.phase === "paused") return;
    activity.current = "check";
    if (manual) {
      setChecking(true);
      setNotice("");
    }
    try {
      const release = await call<Availability>("update_check");
      setUpdate(release.version ? { phase: "available", release } : null);
      if (manual && !release.version) {
        setNotice(release.mode === "manual" ? "This build uses manual downloads." : "You're up to date.");
      }
    } catch {
      if (manual) setNotice("Couldn’t check for updates. Try again.");
    } finally {
      activity.current = null;
      setChecking(false);
    }
  }

  useEffect(() => {
    if (!native) return;
    const timer = window.setTimeout(() => void check(false), 1600);
    return () => window.clearTimeout(timer);
    // Check once on startup; manual checks use the current update state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDownloads() {
    try {
      await call("update_open_downloads");
    } catch {
      setNotice("Couldn’t open the download page.");
      setUpdate(current => current ? { ...current, phase: "error", error: "Couldn’t open the download page." } : null);
    }
  }

  async function download() {
    if (!update?.release.version || activity.current) return;
    const { release } = update;
    if (release.mode !== "installed") return openDownloads();
    activity.current = "download";
    stop.current = null;
    setUpdate({ phase: "downloading", release });
    const progress = new Channel<Transfer>();
    progress.onmessage = (transfer) => {
      if (activity.current === "download" && !stop.current) {
        setUpdate({ phase: transfer.verifying ? "verifying" : "downloading", release, transfer });
      }
    };
    try {
      const ready = await call<boolean>("update_download", { version: release.version, progress });
      setUpdate(stop.current === "cancel" ? null : ready ? { phase: "ready", release } :
        stop.current === "pause" ? { phase: "paused", release } : null);
    } catch {
      setUpdate({ phase: "error", release, error: "Couldn’t download or verify the update." });
    } finally {
      activity.current = null;
      stop.current = null;
      setStopping(false);
    }
  }

  async function cancel(pause = false) {
    if (stop.current || activity.current === "install") return;
    if (activity.current === "download") stop.current = pause ? "pause" : "cancel";
    setStopping(true);
    try {
      await call("update_cancel", { discard: !pause });
      if (activity.current !== "download" && !pause) setUpdate(null);
    } catch {
      stop.current = null;
    } finally {
      if (activity.current !== "download" || !stop.current) setStopping(false);
    }
  }

  async function install() {
    if (update?.phase !== "ready" || activity.current) return;
    activity.current = "install";
    setUpdate({ ...update, phase: "installing" });
    try {
      await call("update_install");
    } catch {
      setUpdate({ ...update, phase: "error", error: "Couldn’t start the installer. Download the update again to retry." });
    } finally {
      activity.current = null;
    }
  }

  return {
    update, checking, notice, stopping, check: () => void check(true),
    download: () => void download(), pause: () => void cancel(true),
    cancel: () => void cancel(), install: () => void install(), openDownloads: () => void openDownloads(),
  };
}
