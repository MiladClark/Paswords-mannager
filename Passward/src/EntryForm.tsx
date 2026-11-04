import {
  Check,
  CircleNotch,
  Eye,
  EyeSlash,
  Plus,
  Shuffle,
  Star,
  X,
} from "@phosphor-icons/react";
import type { FormEvent, RefObject } from "react";
import type { Entry } from "./api";
import type { Key } from "./i18n";
import { IconButton, type Translate } from "./ui";

interface Props {
  draft: Entry;
  folders: string[];
  reveal: boolean;
  busy: boolean;
  t: Translate;
  formRef: RefObject<HTMLFormElement | null>;
  onSubmit: (e: FormEvent) => void;
  onChange: (patch: Partial<Entry>) => void;
  onCancel: () => void;
  onReveal: () => void;
  onGenerate: () => void;
}
export default function EntryForm({
  draft,
  folders,
  reveal,
  busy,
  t,
  formRef,
  onSubmit,
  onChange,
  onCancel,
  onReveal,
  onGenerate,
}: Props) {
  const field = (
    key: "title" | "username" | "url" | "folder",
    label: Key,
    placeholder?: Key,
  ) => (
    <div className="form-field">
      <label htmlFor={`entry-${key}`}>{t(label)}</label>
      <input
        id={`entry-${key}`}
        name={key}
        value={draft[key]}
        onChange={(e) => onChange({ [key]: e.target.value })}
        placeholder={placeholder ? t(placeholder) : undefined}
        required={key === "title"}
        maxLength={
          key === "title"
            ? 512
            : key === "folder"
              ? 128
              : key === "username"
                ? 2048
                : 4096
        }
        autoComplete="off"
        spellCheck={false}
        dir={key === "url" || key === "username" ? "ltr" : "auto"}
        autoFocus={key === "title"}
        list={key === "folder" ? "folders" : undefined}
        aria-describedby={key === "url" ? "website-help" : undefined}
      />
      {key === "url" && (
        <span className="field-help" id="website-help">
          {t("urlHelp")}
        </span>
      )}
    </div>
  );
  return (
    <form ref={formRef} className="editor" onSubmit={onSubmit}>
      <div className="detail-heading">
        <div>
          <span className="section-caption">
            {t(draft.id ? "editTitle" : "newTitle")}
          </span>
          <h1 dir="auto">{draft.title || t("new")}</h1>
        </div>
        <IconButton label={t("close")} onClick={onCancel} disabled={busy}>
          <X />
        </IconButton>
      </div>
      <div className="editor-fields">
        {field("title", "title", "titlePlaceholder")}
        {field("username", "username", "usernamePlaceholder")}
        <div className="form-field">
          <label htmlFor="entry-password">{t("password")}</label>
          <div className="input-action">
            <input
              id="entry-password"
              name="password"
              type={reveal ? "text" : "password"}
              value={draft.password}
              onChange={(e) => onChange({ password: e.target.value })}
              autoComplete="new-password"
              spellCheck={false}
              dir="ltr"
              maxLength={4096}
            />
            <IconButton label={t(reveal ? "hide" : "show")} onClick={onReveal}>
              {reveal ? <EyeSlash /> : <Eye />}
            </IconButton>
            <IconButton label={t("generate")} onClick={onGenerate}>
              <Shuffle />
            </IconButton>
          </div>
        </div>
        {field("url", "website", "websitePlaceholder")}
        <div className="form-grid">
          {field("folder", "folder")}
          <label className="form-field" htmlFor="entry-tags">
            <span>{t("tags")}</span>
            <input
              id="entry-tags"
              name="tags"
              value={draft.tags.join(", ")}
              placeholder={t("tagsHint")}
              onChange={(e) =>
                onChange({
                  tags: e.target.value
                    .replace(/،/g, ",")
                    .split(",")
                    .map((s) => s.trimStart()),
                })
              }
              maxLength={1400}
            />
          </label>
        </div>
        <datalist id="folders">
          {folders.map((f) => (
            <option value={f} key={f} />
          ))}
        </datalist>
        <label className="form-field" htmlFor="entry-notes">
          <span>{t("notes")}</span>
          <textarea
            id="entry-notes"
            name="notes"
            value={draft.notes}
            onChange={(e) => onChange({ notes: e.target.value })}
            placeholder={t("notesPlaceholder")}
            rows={3}
            maxLength={131072}
            dir="auto"
          />
        </label>
        {draft.fields.map((f, i) => (
          <div className="custom-field-editor" key={i}>
            <input
              name={`field-label-${i}`}
              aria-label={t("fieldName")}
              placeholder={t("fieldName")}
              value={f.label}
              maxLength={128}
              onChange={(e) =>
                onChange({
                  fields: draft.fields.map((value, j) =>
                    j === i ? { ...value, label: e.target.value } : value,
                  ),
                })
              }
            />
            <div className="input-action">
              <input
                name={`field-value-${i}`}
                aria-label={t("fieldValue")}
                placeholder={t("fieldValue")}
                value={f.value}
                type={f.hidden ? "password" : "text"}
                dir="auto"
                maxLength={8192}
                autoComplete="off"
                onChange={(e) =>
                  onChange({
                    fields: draft.fields.map((value, j) =>
                      j === i ? { ...value, value: e.target.value } : value,
                    ),
                  })
                }
              />
              <IconButton
                label={t("secretField")}
                pressed={f.hidden}
                onClick={() =>
                  onChange({
                    fields: draft.fields.map((value, j) =>
                      j === i ? { ...value, hidden: !value.hidden } : value,
                    ),
                  })
                }
              >
                {f.hidden ? <EyeSlash size={15} /> : <Eye size={15} />}
              </IconButton>
            </div>
            <IconButton
              label={t("removeField")}
              onClick={() =>
                onChange({ fields: draft.fields.filter((_, j) => j !== i) })
              }
            >
              <X size={15} />
            </IconButton>
          </div>
        ))}
        {draft.fields.length < 24 && (
          <button
            type="button"
            className="text-button add-field"
            onClick={() =>
              onChange({
                fields: [
                  ...draft.fields,
                  { label: "", value: "", hidden: false },
                ],
              })
            }
          >
            <Plus size={15} />
            {t("addField")}
          </button>
        )}
      </div>
      <div className="editor-footer">
        <label className="checkbox-label">
          <input
            name="favorite"
            type="checkbox"
            checked={draft.favorite}
            onChange={(e) => onChange({ favorite: e.target.checked })}
          />
          <Star size={15} />
          {t("favorites")}
        </label>
        <div>
          <button
            type="button"
            className="secondary"
            onClick={onCancel}
            disabled={busy}
          >
            {t("cancel")}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? <CircleNotch className="spin" /> : <Check />}
            {t(busy ? "saving" : "save")}
          </button>
        </div>
      </div>
    </form>
  );
}
