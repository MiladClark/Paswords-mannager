import {
  ArrowSquareOut,
  Copy,
  Eye,
  EyeSlash,
  FolderSimple,
  PencilSimple,
  Star,
  Trash,
  LockSimple,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { EntryView } from "./api";
import type { Language } from "./i18n";
import { hostname, IconButton, initials, type Translate } from "./ui";
interface Props {
  entry: EntryView;
  t: Translate;
  language: Language;
  busy: boolean;
  onFavorite: () => void;
  onEdit: () => void;
  onCopy: (field: string) => void;
  onOpen: () => void;
  onTrash: (deleted: boolean) => void;
  onDelete: () => void;
  pinEnabled: boolean;
  revealRequest: number;
  onUnlock: () => void;
  onRelock: () => void;
}
export default function EntryDetail({
  entry,
  t,
  language,
  busy,
  onFavorite,
  onEdit,
  onCopy,
  onOpen,
  onTrash,
  onDelete,
  pinEnabled,
  revealRequest,
  onUnlock,
  onRelock,
}: Props) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  useEffect(() => {
    setRevealed(new Set());
  }, [entry.id]);
  useEffect(() => {
    if (entry.protected) setRevealed(new Set());
  }, [entry.protected]);
  useEffect(() => {
    if (revealRequest && !entry.protected) setRevealed(new Set(["password"]));
  }, [revealRequest]);
  function toggle(key: string) {
    setRevealed((value) => {
      const next = new Set(value);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function date(value: number) {
    return new Intl.DateTimeFormat(language === "fa" ? "fa-IR" : "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(value * 1000);
  }
  return (
    <article className="entry-detail">
      <div className="detail-heading">
        <div className="entry-title">
          <span className="monogram large" aria-hidden="true">
            {initials(entry.title)}
          </span>
          <div>
            <h1 dir="auto">{entry.title}</h1>
            <span className="detail-domain" dir="ltr">
              {hostname(entry.url) || t("noFolder")}
            </span>
          </div>
        </div>
        <div className="detail-actions">
          {pinEnabled && !entry.protected && (
            <IconButton label={t("lockItem")} onClick={onRelock}>
              <LockSimple size={16} />
            </IconButton>
          )}
          {!entry.deleted && (
            <>
              <IconButton
                label={t(entry.favorite ? "unfavorite" : "favorite")}
                pressed={entry.favorite}
                className={entry.favorite ? "is-favorite" : ""}
                onClick={onFavorite}
                disabled={busy}
              >
                <Star weight={entry.favorite ? "fill" : "regular"} />
              </IconButton>
              <button
                type="button"
                className="secondary edit-button"
                onClick={onEdit}
                disabled={busy}
              >
                <PencilSimple size={15} />
                {t("edit")}
              </button>
            </>
          )}
        </div>
      </div>
      {entry.protected && (
        <div className="item-lock-notice">
          <LockSimple size={16} />
          <span>{t("pinDetailsHidden")}</span>
          <button type="button" className="secondary" onClick={onUnlock}>
            {t("unlockItem")}
          </button>
        </div>
      )}
      {entry.deleted && (
        <div className="trash-notice">
          <Trash size={16} />
          <span>{t("trash")}</span>
          <button
            type="button"
            className="text-button"
            onClick={() => onTrash(false)}
            disabled={busy}
          >
            {t("restore")}
          </button>
        </div>
      )}
      <div className="detail-fields">
        <div className="detail-field">
          <div>
            <span className="field-label">{t("username")}</span>
            <p dir="auto">{entry.username || "—"}</p>
          </div>
          <IconButton
            label={t("copyUsername")}
            onClick={() => onCopy("username")}
            disabled={!entry.username}
          >
            <Copy size={16} />
          </IconButton>
        </div>
        <div className="detail-field">
          <div className="secret-value">
            <span className="field-label">{t("password")}</span>
            <p
              className={`password-value ${!revealed.has("password") ? "masked" : ""}`}
              dir="ltr"
            >
              {entry.hasPassword
                ? revealed.has("password")
                  ? entry.password
                  : "••••••••••••••••"
                : "—"}
            </p>
          </div>
          <div className="field-actions">
            <IconButton
              label={t(revealed.has("password") ? "hide" : "show")}
              onClick={() =>
                entry.protected ? onUnlock() : toggle("password")
              }
              disabled={!entry.hasPassword}
            >
              {revealed.has("password") ? (
                <EyeSlash size={16} />
              ) : (
                <Eye size={16} />
              )}
            </IconButton>
            <IconButton
              label={t("copyPassword")}
              onClick={() => onCopy("password")}
              disabled={!entry.hasPassword}
            >
              <Copy size={16} />
            </IconButton>
          </div>
        </div>
        {entry.password && (
          <div className="password-quality" title={t("passwordTip")}>
            <span
              className={`quality-track length-${entry.password.length < 12 ? "short" : entry.password.length < 20 ? "medium" : "long"}`}
            />
            <span>
              {t(
                entry.password.length < 12
                  ? "weak"
                  : entry.password.length < 20
                    ? "fair"
                    : "strong",
              )}
            </span>
          </div>
        )}
        {entry.url && (
          <div className="detail-field">
            <div>
              <span className="field-label">{t("website")}</span>
              <p dir="ltr" className="website-value">
                {entry.url}
              </p>
            </div>
            <div className="field-actions">
              <IconButton label={t("copy")} onClick={() => onCopy("url")}>
                <Copy size={16} />
              </IconButton>
              <IconButton label={t("openWebsite")} onClick={onOpen}>
                <ArrowSquareOut size={16} />
              </IconButton>
            </div>
          </div>
        )}
        {entry.folder && (
          <div className="detail-field">
            <div>
              <span className="field-label">{t("folder")}</span>
              <p className="folder-value">
                <FolderSimple size={15} />
                <span dir="auto">{entry.folder}</span>
              </p>
            </div>
          </div>
        )}
        {entry.tags.length > 0 && (
          <div className="detail-tags" aria-label={t("tags")}>
            {entry.tags.map((tag) => (
              <span key={tag} dir="auto">
                {tag}
              </span>
            ))}
          </div>
        )}
        {entry.notes && (
          <div className="notes-block">
            <span className="field-label">{t("notes")}</span>
            <p dir="auto">{entry.notes}</p>
          </div>
        )}
        {entry.fields.map((field, i) => (
          <div className="detail-field" key={i}>
            <div>
              <span className="field-label" dir="auto">
                {field.label}
              </span>
              <p dir="auto" className={field.hidden ? "password-value" : ""}>
                {field.hidden && !revealed.has(`extra:${i}`)
                  ? "••••••••••••"
                  : field.value || "—"}
              </p>
            </div>
            <div className="field-actions">
              {field.hidden && (
                <IconButton
                  label={t(revealed.has(`extra:${i}`) ? "hide" : "show")}
                  onClick={() => toggle(`extra:${i}`)}
                >
                  {revealed.has(`extra:${i}`) ? (
                    <EyeSlash size={16} />
                  ) : (
                    <Eye size={16} />
                  )}
                </IconButton>
              )}
              <IconButton
                label={t("copy")}
                onClick={() => onCopy(`extra:${i}`)}
              >
                <Copy size={16} />
              </IconButton>
            </div>
          </div>
        ))}
        {entry.history.length > 0 && (
          <details className="history">
            <summary>
              {t("history")}
              <span>{entry.history.length}</span>
            </summary>
            <p className="field-help">{t("historyHint")}</p>
            {entry.history.map((value, i) => (
              <div className="history-row" key={i}>
                <span dir="ltr" className="password-value">
                  {revealed.has(`history:${i}`) ? value : "••••••••••••"}
                </span>
                <IconButton
                  label={t(revealed.has(`history:${i}`) ? "hide" : "show")}
                  onClick={() => toggle(`history:${i}`)}
                >
                  {revealed.has(`history:${i}`) ? (
                    <EyeSlash size={15} />
                  ) : (
                    <Eye size={15} />
                  )}
                </IconButton>
                <IconButton
                  label={t("copyPassword")}
                  onClick={() => onCopy(`history:${i}`)}
                >
                  <Copy size={15} />
                </IconButton>
              </div>
            ))}
          </details>
        )}
      </div>
      <footer className="entry-footer">
        <div>
          <span>
            {t("updated")} {date(entry.updatedAt)}
          </span>
          <span>
            {t("created")} {date(entry.createdAt)}
          </span>
        </div>
        {entry.deleted ? (
          <button
            type="button"
            className="text-button danger"
            onClick={onDelete}
          >
            {t("deleteForever")}
          </button>
        ) : (
          <IconButton
            label={t("moveTrash")}
            onClick={() => onTrash(true)}
            disabled={busy}
          >
            <Trash size={16} />
          </IconButton>
        )}
      </footer>
    </article>
  );
}
