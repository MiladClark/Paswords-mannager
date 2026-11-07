import { useState, type FormEvent } from "react";
import { ArrowsClockwise, CircleNotch, CloudArrowDown, CloudArrowUp } from "@phosphor-icons/react";
import { syncStageText, type Snapshot, type SyncStage } from "./CloudBackup";
import { Dialog, SecretInput, type Translate } from "./ui";

export default function CloudSyncDialog({ snapshot, needsPassword, busy, stage, error, t, onClose, onConfirm }: {
  snapshot: Snapshot;
  needsPassword: boolean;
  busy: boolean;
  stage: SyncStage;
  error: string;
  t: Translate;
  onClose: () => void;
  onConfirm: (password?: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || (needsPassword && !password)) return;
    const secret = needsPassword ? password : undefined;
    setPassword("");
    await onConfirm(secret);
  }
  return (
    <Dialog title={t("cloudMergeTitle")} onClose={onClose} busy={busy}>
      <form className="dialog-form cloud-sync-form" onSubmit={submit}>
        <p>{t("cloudMergeBody")}</p>
        <div className="cloud-sync-backup">
          <CloudArrowDown size={20} aria-hidden="true" />
          <div>
            <span>{t("cloudLatestBackup")}</span>
            <time dateTime={snapshot.createdAt}>{new Date(snapshot.createdAt).toLocaleString()}</time>
          </div>
        </div>
        <p className="field-help">{t("cloudMergeHint")}</p>
        {needsPassword && (
          <SecretInput id="sync-backup-password" label={t("cloudBackupPassword")}
            value={password} onChange={setPassword} t={t} autoFocus disabled={busy}
            hint={t("cloudSyncPasswordHint")} />
        )}
        {busy && (
          <p className="cloud-sync-progress" role="status">
            <span className="cloud-sync-motion" aria-hidden="true"><CloudArrowDown size={18} /><CloudArrowUp size={18} /></span>
            {t(syncStageText[stage])}
          </p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-footer">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="primary" disabled={busy || (needsPassword && !password)} data-dialog-autofocus={!needsPassword || undefined}>
            {busy ? <CircleNotch className="spin" /> : <ArrowsClockwise />}
            {t(busy ? "working" : "cloudMergeAction")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
