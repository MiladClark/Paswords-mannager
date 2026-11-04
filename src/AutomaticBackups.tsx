import { useEffect, useState } from "react";
import { type Translate } from "./ui";
interface Info {
  enabled: boolean;
  lastCreated: number;
  retained: number;
}
interface Props {
  t: Translate;
  run: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  onError: (cause: unknown) => void;
}
export default function AutomaticBackups({ t, run, onError }: Props) {
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
      <label className="backup-toggle">
        <input
          type="checkbox"
          checked={info?.enabled ?? false}
          disabled={!info || busy}
          onChange={(e) => void configure(e.target.checked)}
        />
        <span>{t("automaticBackups")}</span>
      </label>
      <p className="field-help">{t("automaticBackupHint")}</p>
      {!!info?.retained && (
        <p className="field-help">
          {info.retained} {t("automaticBackupCount")}
        </p>
      )}
    </div>
  );
}
