import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import MotionPresence from "./MotionPresence";

interface Option {
  value: string;
  label: string;
}

export default function Dropdown({
  label,
  value,
  options,
  onChange,
  align = "start",
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  align?: "start" | "end";
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 200,
    maxHeight: 280,
  });
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  function show(index = selected) {
    setActive(index);
    setOpen(true);
  }
  function choose(index: number) {
    onChange(options[index].value);
    setOpen(false);
    trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.min(Math.max(208, rect.width), window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 18;
      const rowHeight = window.matchMedia("(pointer: coarse)").matches
        ? 48
        : 36;
      const height = Math.min(288, options.length * rowHeight + 12);
      const above = below < height && rect.top > below;
      setPosition({
        left: Math.max(
          12,
          Math.min(
            align === "end" ? rect.right - width : rect.left,
            window.innerWidth - width - 12,
          ),
        ),
        top: above ? Math.max(12, rect.top - height - 6) : rect.bottom + 6,
        width,
        maxHeight: Math.min(
          height,
          Math.max(76, above ? rect.top - 18 : below),
        ),
      });
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, options.length, align]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target))
        setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useLayoutEffect(() => {
    if (open)
      menu.current
        ?.querySelector(`#${CSS.escape(id)}-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open, id]);

  function keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    const key = event.key;
    if (key === "Tab") {
      setOpen(false);
      return;
    }
    if (key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)) {
      event.preventDefault();
      if (!open) {
        show(
          key === "Home" ? 0 : key === "End" ? options.length - 1 : selected,
        );
        return;
      }
      if (key === "Enter" || key === " ") {
        choose(active);
        return;
      }
      setActive((index) =>
        key === "Home"
          ? 0
          : key === "End"
            ? options.length - 1
            : (index + (key === "ArrowDown" ? 1 : -1) + options.length) %
              options.length,
      );
    } else if (
      key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      const now = Date.now();
      const text =
        (now - search.current.time < 650 ? search.current.text : "") +
        key.toLocaleLowerCase();
      search.current = { text, time: now };
      const index = options.findIndex((option) =>
        option.label.toLocaleLowerCase().startsWith(text),
      );
      if (index >= 0) {
        setActive(index);
        setOpen(true);
      }
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="filter-dropdown"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={keyboard}
        onBlur={() => setOpen(false)}
      >
        <span>{options[selected]?.label}</span>
        <CaretDown size={12} aria-hidden="true" />
      </button>
      {createPortal(
        <MotionPresence>
          {open && (
            <div
              ref={menu}
              id={id}
              role="listbox"
              aria-label={label}
              className="filter-menu"
              style={position}
              onMouseDown={(event) => event.preventDefault()}
            >
              {options.map((option, index) => (
                <div
                  key={option.value}
                  id={`${id}-${index}`}
                  role="option"
                  aria-selected={value === option.value}
                  className={`filter-option ${active === index ? "is-active" : ""}`}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(index)}
                >
                  <span>{option.label}</span>
                  {value === option.value && (
                    <Check size={14} aria-hidden="true" />
                  )}
                </div>
              ))}
            </div>
          )}
        </MotionPresence>,
        document.body,
      )}
    </>
  );
}
