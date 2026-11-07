import { useEffect, useState } from "react";
import { CloudSwitch, type Translate } from "./ui";
interface Info {
  enabled: boolean;
  lastCreated: number;
  retained: number;
}
interface Props {
  t: Translate;
  run: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  onError: (cause: unknown) => void;
  disabled?: boolean;
}
export default function AutomaticBackups({ t, run, onError, disabled = false }: Props) {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void run<Info>("automatic_backup_info")
      .then((value) => {
        if (active) setInfo(value);
      })
      .catch((cause) => {
        if (active) onError(cause);
      });
    return () => {
      active = false;
    };
  }, []);
  async function configure(enabled: boolean) {
    const previous = info;
    setInfo((value) => (value ? { ...value, enabled } : value));
    setBusy(true);
    try {
      setInfo(await run<Info>("configure_automatic_backups", { enabled }));
    } catch (cause) {
      setInfo(previous);
      onError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="automatic-backups">
      <CloudSwitch label={t("automaticBackups")} checked={info?.enabled ?? false}
        disabled={disabled || !info || busy} onChange={(enabled) => void configure(enabled)} />
      <p className="field-help">{t("settingsAutomaticHint")}</p>
      <details className="settings-backup-details">
        <summary>{t("settingsBackupDetails")}</summary>
        <p className="field-help">{t("automaticBackupHint")}</p>
      </details>
      {!!info?.retained && (
        <p className="field-help">
          {info.retained} {t("automaticBackupCount")}
        </p>
      )}
    </div>
  );
}
