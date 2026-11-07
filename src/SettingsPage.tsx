import { useLayoutEffect, useRef } from "react";
import { version } from "../package.json";
import {
  ArrowLeft,
  ArrowRight,
  DownloadSimple,
  Key,
  ShieldCheck,
  SignOut,
  UploadSimple,
} from "@phosphor-icons/react";
import { native } from "./api";
import AutomaticBackups from "./AutomaticBackups";
import BrowserSettings from "./BrowserSettings";
import { CloudBackupSettings, useCloudSettings } from "./CloudBackup";
import type { Key as TextKey, Language } from "./i18n";
import type { Translate } from "./ui";
import type { useAppUpdates } from "./updates";

interface Props {
  updates: Pick<
    ReturnType<typeof useAppUpdates>,
    "checking" | "notice" | "update" | "check" | "openDownloads"
  >;
  t: Translate;
  language: Language;
  busy: boolean;
  error: string;
  run: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  onBusy: (value: boolean) => void;
  onError: (cause: unknown) => void;
  onMessage: (key: TextKey) => void;
  onBack: () => void;
  onModal: (value: "master" | "import" | "reset") => void;
}

export default function SettingsPage({
  updates,
  t,
  language,
  busy,
  error,
  run,
  onBusy,
  onError,
  onMessage,
  onBack,
  onModal,
}: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const cloud = useCloudSettings(run);
  const BackArrow = language === "fa" ? ArrowRight : ArrowLeft;
  const NextArrow = language === "fa" ? ArrowLeft : ArrowRight;

  useLayoutEffect(() => {
    heading.current?.focus();
  }, []);

  async function exportBackup() {
    onBusy(true);
    try {
      if (await run<boolean>("export_backup", { language }))
        onMessage("backupSaved");
    } catch (cause) {
      onError(cause);
    } finally {
      onBusy(false);
    }
  }

  return (
    <main
      className="settings-page"
      aria-labelledby="settings-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && !busy)
          onBack();
      }}
    >
      <div className="settings-content">
        <header className="settings-header">
          <button
            type="button"
            className="text-button settings-back"
            onClick={onBack}
            disabled={busy}
          >
            <BackArrow size={16} />
            {t("backToVault")}
          </button>
          <h1 id="settings-title" ref={heading} tabIndex={-1}>
            {t("settings")}
          </h1>
        </header>
        {native && (
          <section>
            <h2>Updates</h2>
            <p>PassWards {version} checks for updates when it opens.</p>
            <div className="settings-buttons">
              <button
                type="button"
                className="secondary"
                onClick={updates.check}
                disabled={
                  updates.checking ||
                  (!!updates.update &&
                    !["available", "error"].includes(updates.update.phase))
                }
              >
                {updates.checking ? "Checking…" : "Check for updates"}
              </button>
              {updates.notice === "This build uses manual downloads." && (
                <button
                  type="button"
                  className="secondary"
                  onClick={updates.openDownloads}
                >
                  Open downloads
                </button>
              )}
            </div>
            {updates.notice && <p role="status">{updates.notice}</p>}
          </section>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <section>
          <h2>
            <ShieldCheck size={17} />
            {t("privacyTitle")}
          </h2>
          <p>{t("privacyBody")}</p>
          <dl className="settings-facts">
            <div>
              <dt>{t("autoLock")}</dt>
              <dd>{t("autoLockValue")}</dd>
            </div>
            <div>
              <dt>{t("clipboard")}</dt>
              <dd>{t("clipboardValue")}</dd>
            </div>
          </dl>
          <p className="field-help">{t("lockHidden")}</p>
          <button
            type="button"
            className="settings-link settings-master"
            onClick={() => onModal("master")}
            disabled={busy}
          >
            <Key size={17} />
            <span>{t("changeMaster")}</span>
            <NextArrow size={15} />
          </button>
        </section>
        <BrowserSettings t={t} run={run} onError={onError} />
        <section>
          <h2>{t("backups")}</h2>
          <p>{t("backupBody")}</p>
          <AutomaticBackups t={t} run={run} onError={onError} />
          {native && (
            <CloudBackupSettings
              t={t}
              cloud={cloud}
              busy={busy || !!cloud.pending}
            />
          )}
          <div className="settings-buttons">
            <button
              type="button"
              className="secondary"
              onClick={() => void exportBackup()}
              disabled={busy}
            >
              <DownloadSimple size={16} />
              {t("export")}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => onModal("import")}
              disabled={busy}
            >
              <UploadSimple size={16} />
              {t("import")}
            </button>
          </div>
          <p className="field-help">{t("restoreHint")}</p>
        </section>
        <details className="shortcut-details">
          <summary>{t("shortcuts")}</summary>
          {(
            [
              ["Ctrl N", "shortcutNew"],
              ["Ctrl K", "shortcutSearch"],
              ["Ctrl S", "shortcutSave"],
              ["Ctrl Shift L", "shortcutLock"],
            ] as const
          ).map(([keys, label]) => (
            <div key={keys}>
              <span>{t(label)}</span>
              <kbd>{keys}</kbd>
            </div>
          ))}
        </details>
        <p className="early-note">{t("securityNote")}</p>
        <section
          className="settings-reset"
          aria-labelledby="settings-reset-title"
        >
          <h2 id="settings-reset-title">{t("sessionSettings")}</h2>
          <p>{t("resetSettingsHint")}</p>
          <button
            type="button"
            className="primary reset-button"
            disabled={busy || !!cloud.pending}
            onClick={() => onModal("reset")}
          >
            <SignOut size={16} />
            {t("cloudSignOut")}
          </button>
        </section>
      </div>
    </main>
  );
}
