import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { call, native } from "./api";
import { en, type Key } from "./i18n";
import { CloudSwitch, type Translate } from "./ui";

type Info = { email: string; enabled: boolean; lastBackup: number | null; issue: string | null };

function cloudErrorText(cause: unknown, t: Translate) {
  return typeof cause === "string" && Object.prototype.hasOwnProperty.call(en, cause) ? t(cause as Key) : t("genericError");
}

type Run = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function useCloudSettings(request: Run) {
  const [info, setInfo] = useState<Info | null>(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!native) return;
    let active = true;
    const refresh = () => void call<Info>("cloud_info").then(
      (value) => { if (active) setInfo(value); },
      (cause) => { if (active) setError(cause); },
    );
    refresh();
    const subscription = listen("cloud-backup-changed", refresh);
    void subscription.catch(() => {});
    return () => {
      active = false;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  async function run(command: string, args?: Record<string, unknown>) {
    setPending(command);
    setError(null);
    try {
      setInfo(await request<Info>(command, args));
    } catch (cause) {
      setError(cause);
    } finally {
      setPending("");
    }
  }

  return { info, pending, error, run };
}

export function CloudBackupSettings({ t, cloud, busy }: {
  t: Translate;
  cloud: ReturnType<typeof useCloudSettings>;
  busy: boolean;
}) {
  const { info, pending, error, run } = cloud;
  const needsSignIn = !info?.email || info.issue === "cloudSignInRequired" || error === "cloudSignInRequired";
  const issue = error ?? info?.issue;
  return (
    <div className="automatic-backups">
      <h3>{t("cloudBackup")}</h3>
      <p className="field-help">{t("cloudSettingsHint")}</p>
      {!!info?.email && (
        <>
          <p className="field-help">{t("cloudAccount")} {info.email}</p>
          <CloudSwitch label={t("cloudAutomatic")} checked={info.enabled}
            disabled={busy || needsSignIn}
            onChange={(enabled) => void run("cloud_enable", { enabled })} />
          <p className="field-help">
            {info.lastBackup
              ? `${t("cloudLastBackup")} ${new Date(info.lastBackup * 1000).toLocaleString()}`
              : t("cloudNeverBackedUp")}
          </p>
        </>
      )}
      <div className="settings-buttons">
        {needsSignIn ? (
          <button type="button" className="secondary" disabled={busy || !info}
            onClick={() => void run("cloud_connect")}>{t("cloudConnect")}</button>
        ) : (
          <button type="button" className="secondary" disabled={busy}
            onClick={() => void run("cloud_backup_now")}>{t("cloudBackupNow")}</button>
        )}
        {!!info?.email && (
          <button type="button" className="settings-link" disabled={busy}
            onClick={() => void run("cloud_connect")}>{t("cloudSwitchAccount")}</button>
        )}
      </div>
      {pending === "cloud_connect" && <p className="field-help" role="status">
        {t(info?.email ? "cloudSwitchBrowser" : "cloudWaitingBrowser")}
      </p>}
      {pending === "cloud_backup_now" && <p className="field-help" role="status">{t("cloudUploading")}</p>}
      {!!issue && <p className="form-error" role="alert">{cloudErrorText(issue, t)}</p>}
    </div>
  );
}
