import { useLayoutEffect, useRef, useState } from "react";
import { version } from "../package.json";
import {
  ArrowLeft, ArrowRight, ArrowsClockwise, DownloadSimple, GearSix,
  Globe, Key, ShieldCheck, SignOut, UploadSimple,
} from "@phosphor-icons/react";
import { native, preview } from "./api";
import AutomaticBackups from "./AutomaticBackups";
import BrowserSettings from "./BrowserSettings";
import { CloudBackupSettings, type useCloudSettings } from "./CloudBackup";
import type { Key as TextKey, Language } from "./i18n";
import type { Translate } from "./ui";
import type { useAppUpdates } from "./updates";

type Section = "sync" | "security" | "browsers" | "app";
const sections = [
  { id: "sync", label: "settingsSync", hint: "settingsSyncHint", icon: ArrowsClockwise },
  { id: "security", label: "settingsSecurity", hint: "settingsSecurityHint", icon: ShieldCheck },
  { id: "browsers", label: "browsers", hint: "settingsBrowsersHint", icon: Globe },
  { id: "app", label: "settingsApp", hint: "settingsAppHint", icon: GearSix },
] as const;

interface Props {
  updates: Pick<ReturnType<typeof useAppUpdates>, "checking" | "notice" | "update" | "check" | "openDownloads">;
  t: Translate;
  language: Language;
  busy: boolean;
  error: string;
  run: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  cloud: ReturnType<typeof useCloudSettings>;
  onCloudAction: () => void;
  onCloudConnect: () => void;
  onBusy: (value: boolean) => void;
  onError: (cause: unknown) => void;
  onMessage: (key: TextKey) => void;
  onBack: () => void;
  onModal: (value: "master" | "import" | "reset") => void;
}

export default function SettingsPage({
  updates, t, language, busy, error, run, cloud, onCloudAction, onCloudConnect,
  onBusy, onError, onMessage, onBack, onModal,
}: Props) {
  const [section, setSection] = useState<Section>("sync");
  const heading = useRef<HTMLHeadingElement>(null);
  const BackArrow = language === "fa" ? ArrowRight : ArrowLeft;
  const NextArrow = language === "fa" ? ArrowLeft : ArrowRight;
  const working = busy || !!cloud.pending;
  const current = sections.find((item) => item.id === section)!;

  useLayoutEffect(() => {
    heading.current?.focus();
  }, []);

  async function exportBackup() {
    onBusy(true);
    try {
      if (await run<boolean>("export_backup", { language })) onMessage("backupSaved");
    } catch (cause) {
      onError(cause);
    } finally {
      onBusy(false);
    }
  }

  return (
    <main className="settings-page" aria-labelledby="settings-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && !working) onBack();
      }}>
      <div className="settings-content">
        <header className="settings-header">
          <button type="button" className="text-button settings-back" onClick={onBack} disabled={working}>
            <BackArrow size={16} />{t("backToVault")}
          </button>
          <div className="settings-title-row">
            <div>
              <h1 id="settings-title" ref={heading} tabIndex={-1}>{t("settings")}</h1>
              <p>{t("settingsIntro")}</p>
            </div>
            <span className="settings-version">PassWards {version}</span>
          </div>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t("settingsSections")}>
            {sections.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" aria-pressed={section === id}
                aria-controls="settings-panel" disabled={working} onClick={() => setSection(id)}>
                <Icon size={17} aria-hidden="true" /><span>{t(label)}</span>
              </button>
            ))}
          </nav>

          <div id="settings-panel" className="settings-panel" role="region" aria-labelledby="settings-section-title">
            <header className="settings-panel-heading">
              <h2 id="settings-section-title">{t(current.label)}</h2>
              <p>{t(current.hint)}</p>
            </header>
            {error && <p className="form-error settings-error" role="alert">{error}</p>}

            {section === "sync" && (
              <>
                {(native || preview) && (
                  <CloudBackupSettings t={t} cloud={cloud} busy={working}
                    onAction={onCloudAction} onConnect={onCloudConnect} />
                )}
                <section className="settings-group" aria-labelledby="settings-files-title">
                  <h3 id="settings-files-title">{t("settingsBackupFiles")}</h3>
                  <div className="settings-action-rows">
                    <button type="button" className="settings-action-row" aria-label={t("export")} disabled={working} onClick={() => void exportBackup()}>
                      <DownloadSimple size={18} aria-hidden="true" />
                      <span><strong>{t("export")}</strong><small>{t("settingsExportHint")}</small></span>
                      <NextArrow size={16} aria-hidden="true" />
                    </button>
                    <button type="button" className="settings-action-row" aria-label={t("import")} disabled={working} onClick={() => onModal("import")}>
                      <UploadSimple size={18} aria-hidden="true" />
                      <span><strong>{t("import")}</strong><small>{t("settingsImportHint")}</small></span>
                      <NextArrow size={16} aria-hidden="true" />
                    </button>
                  </div>
                </section>
                <section className="settings-group" aria-labelledby="settings-local-title">
                  <h3 id="settings-local-title">{t("settingsLocalBackups")}</h3>
                  <AutomaticBackups t={t} run={run} onError={onError} disabled={working} />
                </section>
              </>
            )}

            {section === "security" && (
              <>
                <section className="settings-group settings-group-first" aria-labelledby="settings-protection-title">
                  <h3 id="settings-protection-title">{t("settingsProtection")}</h3>
                  <dl className="settings-facts">
                    <div><dt>{t("autoLock")}</dt><dd>{t("autoLockValue")}</dd></div>
                    <div><dt>{t("clipboard")}</dt><dd>{t("clipboardValue")}</dd></div>
                  </dl>
                  <p className="field-help">{t("lockHidden")}</p>
                  <button type="button" className="settings-action-row settings-password-action"
                    aria-label={t("changeMaster")} disabled={working} onClick={() => onModal("master")}>
                    <Key size={18} aria-hidden="true" />
                    <span><strong>{t("changeMaster")}</strong><small>{t("settingsMasterHint")}</small></span>
                    <NextArrow size={16} aria-hidden="true" />
                  </button>
                </section>
                <section className="settings-group settings-reset" aria-labelledby="settings-reset-title">
                  <div className="settings-row">
                    <div className="settings-row-copy">
                      <h3 id="settings-reset-title">{t("sessionSettings")}</h3>
                      <p>{t("resetSettingsHint")}</p>
                    </div>
                    <button type="button" className="secondary settings-signout" disabled={working} onClick={() => onModal("reset")}>
                      <SignOut size={16} />{t("cloudSignOut")}
                    </button>
                  </div>
                </section>
              </>
            )}

            {section === "browsers" && (
              <BrowserSettings t={t} run={run} onError={onError} disabled={working} />
            )}

            {section === "app" && (
              <>
                <section className="settings-group settings-group-first" aria-labelledby="settings-version-title">
                  <div className="settings-row">
                    <div className="settings-row-copy">
                      <h3 id="settings-version-title">PassWards {version}</h3>
                      <p>{t("settingsUpdateHint")}</p>
                    </div>
                    {native && <button type="button" className="secondary" onClick={updates.check}
                      disabled={working || updates.checking || (!!updates.update && !["available", "error"].includes(updates.update.phase))}>
                      {t(updates.checking ? "settingsCheckingUpdates" : "settingsCheckUpdates")}
                    </button>}
                  </div>
                  {updates.notice && <p className="field-help" role="status">{updates.notice}</p>}
                  {updates.notice === "This build uses manual downloads." && (
                    <button type="button" className="text-button" onClick={updates.openDownloads}>{t("settingsOpenDownloads")}</button>
                  )}
                </section>
                <section className="settings-group" aria-labelledby="settings-shortcuts-title">
                  <h3 id="settings-shortcuts-title">{t("shortcuts")}</h3>
                  <dl className="settings-shortcuts">
                    {([
                      ["Ctrl N", "shortcutNew"], ["Ctrl K", "shortcutSearch"],
                      ["Ctrl S", "shortcutSave"], ["Ctrl Shift L", "shortcutLock"],
                    ] as const).map(([keys, label]) => (
                      <div key={keys}><dt>{t(label)}</dt><dd><kbd>{keys}</kbd></dd></div>
                    ))}
                  </dl>
                </section>
                <p className="settings-security-note">{t("securityNote")}</p>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
