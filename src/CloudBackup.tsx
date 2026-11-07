import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowsClockwise, CloudArrowUp } from "@phosphor-icons/react";
import { call, native, preview } from "./api";
import { en, type Key } from "./i18n";
import { CloudSwitch, type Translate } from "./ui";

export type CloudInfo = { email: string; enabled: boolean; lastBackup: number | null; issue: string | null };
export type Snapshot = { id: string; createdAt: string; size: number };
export type SyncResult = { imported: number; info: CloudInfo };
export type SyncStage = "downloading" | "merging" | "preparing" | "checking" | "uploading" | "finishing";
export const syncStageText: Record<SyncStage, Key> = {
  downloading: "cloudDownloading", merging: "cloudMerging", preparing: "cloudPreparing",
  checking: "cloudChecking", uploading: "cloudUploading", finishing: "cloudFinishing",
};

function cloudErrorText(cause: unknown, t: Translate) {
  return typeof cause === "string" && Object.prototype.hasOwnProperty.call(en, cause) ? t(cause as Key) : t("genericError");
}

type Run = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function useCloudSettings(request: Run, active = true) {
  const [info, setInfo] = useState<CloudInfo | null>(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if ((!native && !preview) || !active) return;
    let mounted = true;
    const refresh = () => void call<CloudInfo>("cloud_info").then(
      (value) => { if (mounted) { setInfo(value); setError(null); } },
      (cause) => { if (mounted) setError(cause); },
    );
    refresh();
    const subscription = native ? listen("cloud-backup-changed", refresh) : Promise.resolve(() => {});
    void subscription.catch(() => {});
    return () => {
      mounted = false;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [active]);

  async function run(command: string, args?: Record<string, unknown>) {
    setPending(command);
    setError(null);
    try {
      setInfo(await request<CloudInfo>(command, args));
    } catch (cause) {
      if (cause !== "stale") setError(cause);
    } finally {
      setPending("");
    }
  }

  function acceptInfo(value: CloudInfo) {
    setInfo(value);
    setError(null);
  }

  return { info, pending, error, run, setInfo: acceptInfo };
}

export function CloudBackupSettings({ t, cloud, busy, onAction, onConnect }: {
  t: Translate;
  cloud: ReturnType<typeof useCloudSettings>;
  busy: boolean;
  onAction: () => void;
  onConnect: () => void;
}) {
  const { info, pending, error, run } = cloud;
  const needsSignIn = !info?.email || info.issue === "cloudSignInRequired" || error === "cloudSignInRequired";
  const issue = error ?? info?.issue;
  return (
    <section className="settings-cloud" aria-labelledby="settings-cloud-title">
      <div className="settings-row settings-cloud-heading">
        <div className="settings-row-copy">
          <h3 id="settings-cloud-title">DevTune</h3>
          <p>{needsSignIn ? t("settingsCloudDisconnected") : <bdi>{info?.email}</bdi>}</p>
        </div>
        <button type="button" className="primary" disabled={busy || !info} onClick={onAction}>
          {needsSignIn ? <CloudArrowUp size={16} /> : <ArrowsClockwise size={16} />}
          {t(needsSignIn ? "cloudConnectShort" : "cloudSyncShort")}
        </button>
      </div>
      <p className="field-help">{t("settingsCloudHint")}</p>
      {!!info?.email && (
        <div className="settings-cloud-options">
          <CloudSwitch label={t("cloudAutomatic")} checked={info.enabled}
            disabled={busy || needsSignIn}
            onChange={(enabled) => void run("cloud_enable", { enabled })} />
          <div className="settings-cloud-footer">
            <p className="field-help">
              {info.lastBackup
                ? <>{t("cloudLastBackup")} <time dateTime={new Date(info.lastBackup * 1000).toISOString()}>{new Date(info.lastBackup * 1000).toLocaleString()}</time></>
                : t("cloudNeverBackedUp")}
            </p>
            <button type="button" className="text-button" disabled={busy} onClick={onConnect}>{t("cloudSwitchAccount")}</button>
          </div>
        </div>
      )}
      {!!pending && <p className="field-help" role="status">{t("working")}</p>}
      {!!issue && <p className="form-error" role="alert">{cloudErrorText(issue, t)}</p>}
    </section>
  );
}
