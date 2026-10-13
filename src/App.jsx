import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import "./App.css";

/* ------------------------------------------------------------------ */
/*  Constants & helpers                                                */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "job-json-generator:v1";
const DOWNLOAD_NAME = "job-config.json";

const INITIAL_DOC = {
  runAgain: false,
  startSequence: null,
  endSequence: null,
  batchSize: null,
  currentDate: 1790060306570,
  lastScheduledStartTime: 1790060105000,
  nextRunTime: 1790060300000,
  noOfFiles: -1,
  configs: {},
  dryRun: false,
};

const newConfig = () => ({
  parent: null,
  currentResponse: null,
  translatorMap: {},
  values: {},
});

/** Which editor opens for each config property, and what it accepts. */
const FIELD_META = {
  currentResponse: {
    title: "Current response",
    kind: "any", // object or array
    empty: null,
    openWith: "{}",
    hint: "Paste any JSON object or array.",
  },
  translatorMap: {
    title: "Translator map",
    kind: "object",
    empty: {},
    openWith: "{}",
    hint: "Paste a JSON object. Nested objects and numeric keys are fine.",
  },
  values: {
    title: "Values",
    kind: "object",
    empty: {},
    openWith: "{}",
    hint: "Paste a JSON object. Strings, numbers, booleans, arrays and null are kept as typed.",
  },
};

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const format = (v) => JSON.stringify(v, null, 2);

const clone = (v) => JSON.parse(JSON.stringify(v));

function isFilled(field, value) {
  if (value === null || value === undefined) return false;
  if (field === "currentResponse") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function sizeLabel(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (isPlainObject(value)) {
    const n = Object.keys(value).length;
    return `${n} key${n === 1 ? "" : "s"}`;
  }
  return "set";
}

/** Turn a JSON.parse error into { message, line } for display. */
function describeParseError(err, text) {
  const raw = String(err && err.message ? err.message : err);
  let line = null;

  const lc = raw.match(/line (\d+) column (\d+)/i);
  if (lc) {
    line = Number(lc[1]);
  } else {
    const pos = raw.match(/position (\d+)/i);
    if (pos) {
      const index = Number(pos[1]);
      line = text.slice(0, index).split("\n").length;
    }
  }

  const message = raw
    .replace(/\s*\(line \d+ column \d+\)/i, "")
    .replace(/\s*in JSON at position \d+/i, "")
    .replace(/\s*at position \d+/i, "");

  return { message, line };
}

/** Structural checks on the full document. Returns an error string or null. */
function validateDocument(obj) {
  if (!isPlainObject(obj)) return "The root of the document must be a JSON object.";
  if (!isPlainObject(obj.configs)) return '"configs" must be an object.';
  for (const [key, cfg] of Object.entries(obj.configs)) {
    if (!isPlainObject(cfg)) return `Config "${key}" must be an object.`;
  }
  return null;
}

/** Parse + validate editor text. */
function analyze(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { doc: null, error: describeParseError(err, text) };
  }
  const problem = validateDocument(parsed);
  if (problem) return { doc: null, error: { message: problem, line: null } };
  return { doc: parsed, error: null };
}

function validateSnippet(text, kind) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { value: null, error: describeParseError(err, text) };
  }
  if (kind === "any" && !(Array.isArray(parsed) || isPlainObject(parsed))) {
    return { value: null, error: { message: "This must be a JSON object or array.", line: null } };
  }
  if (kind === "object" && !isPlainObject(parsed)) {
    return { value: null, error: { message: "This must be a JSON object.", line: null } };
  }
  return { value: parsed, error: null };
}

function loadState() {
  const fallback = {
    doc: clone(INITIAL_DOC),
    text: format(INITIAL_DOC),
    error: null,
    counter: 0,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved.text !== "string" || validateDocument(saved.doc)) return fallback;
    const result = analyze(saved.text);
    return {
      doc: result.error ? saved.doc : result.doc,
      text: saved.text,
      error: result.error,
      counter: Number.isInteger(saved.counter) ? saved.counter : 0,
    };
  } catch {
    return fallback;
  }
}

const pad = (n) => String(n).padStart(2, "0");

/** epoch ms -> "YYYY-MM-DDTHH:mm:ss" in local time (for datetime-local inputs). */
function toLocalInput(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "YYYY-MM-DDTHH:mm:ss" (local) -> epoch ms, or null if incomplete. */
function fromLocalInput(str) {
  if (!str) return null;
  const ms = new Date(str).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Monaco setup                                                       */
/* ------------------------------------------------------------------ */

function defineTheme(monaco) {
  monaco.editor.defineTheme("job-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "string.key.json", foreground: "b7a9ff" },
      { token: "string.value.json", foreground: "7fe0c8" },
      { token: "number", foreground: "f2b980" },
      { token: "keyword", foreground: "ff9db0" },
    ],
    colors: {
      "editor.background": "#17161d",
      "editor.lineHighlightBackground": "#201f29",
      "editorLineNumber.foreground": "#5a5769",
      "editorLineNumber.activeForeground": "#a9a5be",
      "editorGutter.background": "#17161d",
      "editorCursor.foreground": "#9b89ff",
      "editor.selectionBackground": "#3b3470",
      "editorIndentGuide.background1": "#2a2833",
      "editorIndentGuide.activeBackground1": "#46435a",
    },
  });
}

const EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
  fontSize: 13,
  lineHeight: 20,
  tabSize: 2,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  formatOnPaste: true,
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: true },
  padding: { top: 12, bottom: 12 },
  smoothScrolling: true,
  renderLineHighlight: "line",
};

const editorLoading = <div className="editor-loading">Loading editor…</div>;

/* ------------------------------------------------------------------ */
/*  Small UI pieces                                                    */
/* ------------------------------------------------------------------ */

function Chevron({ open }) {
  return (
    <svg
      className={`chevron${open ? " open" : ""}`}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="M4 2.5 8 6l-4 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-label">{checked ? "true" : "false"}</span>
      <span className="switch-track" />
    </button>
  );
}

/** Number input that keeps its own draft so "-" or "1." can be typed. */
function NumberInput({ value, onChange, disabled, id, placeholder }) {
  const [draft, setDraft] = useState(value === null || value === undefined ? "" : String(value));

  useEffect(() => {
    setDraft((d) => {
      if (value === null || value === undefined) return "";
      return Number(d) === value && d.trim() !== "" ? d : String(value);
    });
  }, [value]);

  return (
    <input
      id={id}
      className="input mono"
      type="text"
      inputMode="decimal"
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        if (v.trim() !== "" && !Number.isNaN(Number(v))) onChange(Number(v));
      }}
    />
  );
}

function Segmented({ options, value, onChange, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? "active" : ""}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  General settings                                                   */
/* ------------------------------------------------------------------ */

function BoolRow({ label, hint, value, onChange }) {
  return (
    <div className="row">
      <div className="row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <Toggle checked={value === true} onChange={onChange} label={label} />
    </div>
  );
}

function NullableNumberRow({ id, label, value, onChange }) {
  const isNull = value === null || value === undefined;
  return (
    <div className="row stack">
      <div className="row-label">
        <label htmlFor={id}>{label}</label>
      </div>
      <div className="row-control">
        <Segmented
          label={`${label} type`}
          value={isNull ? "null" : "number"}
          onChange={(v) => onChange(v === "null" ? null : 0)}
          options={[
            { value: "null", label: "Null" },
            { value: "number", label: "Number" },
          ]}
        />
        <NumberInput
          id={id}
          value={isNull ? null : value}
          disabled={isNull}
          placeholder="null"
          onChange={onChange}
        />
      </div>
    </div>
  );
}

function NumberRow({ id, label, value, onChange }) {
  return (
    <div className="row stack">
      <div className="row-label">
        <label htmlFor={id}>{label}</label>
      </div>
      <div className="row-control">
        <NumberInput id={id} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

/** Calendar + time picker that reads and writes an epoch-millisecond number. */
function DateTimeRow({ id, label, value, onChange }) {
  const valid = typeof value === "number" && Number.isFinite(value);
  // Keep the original milliseconds so picking a new date/time doesn't silently drop them.
  const keepMs = valid ? ((value % 1000) + 1000) % 1000 : 0;

  return (
    <div className="row stack">
      <div className="row-label">
        <label htmlFor={id}>{label}</label>
        <small className="mono">{valid ? `epoch ${value}` : "not a valid timestamp"}</small>
      </div>
      <div className="row-control">
        <input
          id={id}
          className="input"
          type="datetime-local"
          step="1"
          value={toLocalInput(value)}
          onChange={(e) => {
            const ms = fromLocalInput(e.target.value);
            if (ms !== null) onChange(ms + keepMs);
          }}
        />
        <button type="button" className="btn ghost small" onClick={() => onChange(Date.now())}>
          Now
        </button>
      </div>
    </div>
  );
}

function GeneralSettings({ doc, setField }) {
  const known = [
    "runAgain", "startSequence", "endSequence", "batchSize", "currentDate",
    "lastScheduledStartTime", "nextRunTime", "noOfFiles", "configs", "dryRun",
  ];
  const extras = Object.keys(doc).filter((k) => !known.includes(k));

  return (
    <section className="section">
      <h2 className="section-title">General settings</h2>

      <div className="group">
        <h3>Run control</h3>
        <BoolRow label="Run again" value={doc.runAgain} onChange={(v) => setField("runAgain", v)} />
        <BoolRow label="Dry run" value={doc.dryRun} onChange={(v) => setField("dryRun", v)} />
      </div>

      <div className="group">
        <h3>Sequence and batching</h3>
        <NullableNumberRow id="f-start" label="Start sequence" value={doc.startSequence} onChange={(v) => setField("startSequence", v)} />
        <NullableNumberRow id="f-end" label="End sequence" value={doc.endSequence} onChange={(v) => setField("endSequence", v)} />
        <NullableNumberRow id="f-batch" label="Batch size" value={doc.batchSize} onChange={(v) => setField("batchSize", v)} />
        <NumberRow id="f-files" label="Number of files" value={doc.noOfFiles} onChange={(v) => setField("noOfFiles", v)} />
      </div>

      <div className="group">
        <h3>Timing</h3>
        <DateTimeRow id="f-current" label="Current date" value={doc.currentDate} onChange={(v) => setField("currentDate", v)} />
        <DateTimeRow id="f-last" label="Last scheduled start time" value={doc.lastScheduledStartTime} onChange={(v) => setField("lastScheduledStartTime", v)} />
        <DateTimeRow id="f-next" label="Next run time" value={doc.nextRunTime} onChange={(v) => setField("nextRunTime", v)} />
      </div>

      {extras.length > 0 && (
        <p className="note">
          Extra fields kept from the JSON editor: <span className="mono">{extras.join(", ")}</span>
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Configurations                                                     */
/* ------------------------------------------------------------------ */

function ConfigCard({ id, cfg, otherKeys, collapsed, onToggle, onDelete, onParent, onEdit }) {
  const parent = cfg.parent;
  const parentIsNull = parent === null || parent === undefined;
  const listId = `parents-${id}`;

  return (
    <article className={`card${collapsed ? " collapsed" : ""}`}>
      <header className="card-head">
        <button
          type="button"
          className="card-toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} config ${id}`}
        >
          <Chevron open={!collapsed} />
          <span className="card-key mono">{id}</span>
          <span className="card-name">Config {id}</span>
        </button>
        <button
          type="button"
          className="icon-btn danger"
          onClick={onDelete}
          aria-label={`Delete config ${id}`}
          title="Delete config"
        >
          ×
        </button>
      </header>

      {!collapsed && (
        <div className="card-body">
          <div className="row stack">
            <div className="row-label">
              <label htmlFor={`parent-${id}`}>Parent</label>
            </div>
            <div className="row-control">
              <Segmented
                label={`Config ${id} parent type`}
                value={parentIsNull ? "null" : "value"}
                onChange={(v) => onParent(v === "null" ? null : otherKeys[0] ?? "")}
                options={[
                  { value: "null", label: "Null" },
                  { value: "value", label: "Value" },
                ]}
              />
              <input
                id={`parent-${id}`}
                className="input mono"
                type="text"
                list={listId}
                disabled={parentIsNull}
                placeholder="null"
                spellCheck={false}
                value={parentIsNull ? "" : String(parent)}
                onChange={(e) => onParent(e.target.value)}
              />
              <datalist id={listId}>
                {otherKeys.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </div>
          </div>

          <ul className="props">
            {Object.entries(FIELD_META).map(([field, meta]) => {
              const value = cfg[field];
              const filled = isFilled(field, value);
              return (
                <li key={field} className="prop">
                  <span className={`dot${filled ? " filled" : ""}`} aria-hidden="true" />
                  <div className="prop-text">
                    <span>{meta.title}</span>
                    <small>{filled ? sizeLabel(value) : field === "currentResponse" ? "null" : "empty"}</small>
                  </div>
                  <button type="button" className="btn small" onClick={() => onEdit(field)}>
                    {filled ? "Edit" : "Add"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </article>
  );
}

function ConfigurationsPanel({ doc, collapsed, setCollapsed, addConfig, deleteConfig, updateConfig, openEditor }) {
  const keys = Object.keys(doc.configs);

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Configurations</h2>
        <span className="count">{keys.length}</span>
      </div>

      {keys.length === 0 ? (
        <div className="empty">
          <p>No configurations yet.</p>
          <small>Add one to create <span className="mono">configs["0"]</span> with all four properties.</small>
        </div>
      ) : (
        <div className="cards">
          {keys.map((key) => (
            <ConfigCard
              key={key}
              id={key}
              cfg={doc.configs[key]}
              otherKeys={keys.filter((k) => k !== key)}
              collapsed={!!collapsed[key]}
              onToggle={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
              onDelete={() => deleteConfig(key)}
              onParent={(v) => updateConfig(key, { parent: v })}
              onEdit={(field) => openEditor(key, field)}
            />
          ))}
        </div>
      )}

      <button type="button" className="btn primary wide" onClick={addConfig}>
        + Add config
      </button>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Modal editor                                                       */
/* ------------------------------------------------------------------ */

function JsonModal({ configKey, field, initialText, onSave, onClear, onCancel }) {
  const meta = FIELD_META[field];
  const [text, setText] = useState(initialText);
  const result = useMemo(() => validateSnippet(text, meta.kind), [text, meta.kind]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const prettify = () => {
    if (!result.error) setText(format(result.value));
  };

  return (
    <div className="backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Config ${configKey}: ${meta.title}`}>
        <header className="modal-head">
          <div>
            <h2>
              Config <span className="mono">{configKey}</span> · {meta.title}
            </h2>
            <p>{meta.hint}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="Close editor">
            ×
          </button>
        </header>

        <div className="modal-editor">
          <Editor
            height="100%"
            language="json"
            theme="job-dark"
            value={text}
            beforeMount={defineTheme}
            onChange={(v) => setText(v ?? "")}
            options={EDITOR_OPTIONS}
            loading={editorLoading}
          />
        </div>

        <footer className="modal-foot">
          <div className={`status ${result.error ? "bad" : "good"}`} role="status">
            <span className="status-dot" />
            {result.error ? (
              <span>
                {result.error.line ? `Line ${result.error.line}: ` : ""}
                {result.error.message}
              </span>
            ) : (
              <span>Valid JSON</span>
            )}
          </div>
          <div className="actions">
            <button type="button" className="btn ghost" onClick={onClear}>
              {field === "currentResponse" ? "Remove (set null)" : "Clear (set {})"}
            </button>
            <button type="button" className="btn" onClick={prettify} disabled={!!result.error}>
              Format
            </button>
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!!result.error}
              onClick={() => onSave(result.value)}
            >
              Save
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

export default function App() {
  const [initial] = useState(loadState);
  const [doc, setDoc] = useState(initial.doc); // last valid document (source of truth)
  const [text, setText] = useState(initial.text); // what is in the right-hand editor
  const [error, setError] = useState(initial.error); // parse/validation error for `text`
  const [counter, setCounter] = useState(initial.counter); // next config key, never reused
  const [collapsed, setCollapsed] = useState({});
  const [modal, setModal] = useState(null); // { key, field }
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  /* Persist work so a refresh doesn't lose it. */
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ doc, text, counter }));
    } catch {
      /* storage may be unavailable; the app still works */
    }
  }, [doc, text, counter]);

  const showToast = useCallback((message, tone = "ok") => {
    setToast({ message, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  /* Every change coming from the left panel goes through here. */
  const commit = useCallback((nextDoc) => {
    setDoc(nextDoc);
    setText(format(nextDoc));
    setError(null);
  }, []);

  /* Manual edits in the right-hand editor. */
  const onEditorChange = useCallback((value) => {
    const next = value ?? "";
    setText(next);
    const result = analyze(next);
    if (result.error) {
      setError(result.error); // keep the last valid doc untouched
    } else {
      setDoc(result.doc);
      setError(null);
    }
  }, []);

  const setField = (key, value) => commit({ ...doc, [key]: value });

  const updateConfig = (key, patch) =>
    commit({
      ...doc,
      configs: { ...doc.configs, [key]: { ...doc.configs[key], ...patch } },
    });

  const addConfig = () => {
    const existing = Object.keys(doc.configs)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0);
    const next = Math.max(counter, existing.length ? Math.max(...existing) + 1 : 0);
    setCounter(next + 1);
    commit({ ...doc, configs: { ...doc.configs, [String(next)]: newConfig() } });
  };

  const deleteConfig = (key) => {
    const cfg = doc.configs[key];
    const hasData =
      isFilled("currentResponse", cfg.currentResponse) ||
      isFilled("translatorMap", cfg.translatorMap) ||
      isFilled("values", cfg.values);
    if (hasData && !window.confirm(`Delete config ${key}? It contains data.`)) return;
    const configs = { ...doc.configs };
    delete configs[key];
    commit({ ...doc, configs });
  };

  const openEditor = (key, field) => setModal({ key, field });
  const closeModal = useCallback(() => setModal(null), []);

  const modalInitialText = () => {
    if (!modal) return "{}";
    const meta = FIELD_META[modal.field];
    const value = doc.configs[modal.key]?.[modal.field];
    return value === null || value === undefined ? meta.openWith : format(value);
  };

  const formatJson = () => {
    if (error) return;
    commit(doc);
    showToast("JSON formatted");
  };

  const copyJson = async () => {
    if (error) return;
    const ok = await copyText(text);
    showToast(ok ? "JSON copied successfully." : "Couldn't copy to the clipboard.", ok ? "ok" : "bad");
  };

  const downloadJson = () => {
    if (error) return;
    downloadText(text, DOWNLOAD_NAME);
    showToast(`Downloaded ${DOWNLOAD_NAME}`);
  };

  const resetAll = () => {
    if (!window.confirm("Reset everything to the initial template?")) return;
    setCounter(0);
    setCollapsed({});
    commit(clone(INITIAL_DOC));
    showToast("Reset to the initial template");
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">{"{ }"}</span>
          <h1>Job JSON Generator</h1>
        </div>
        <div className="topbar-actions">
          <button type="button" className="btn ghost" onClick={resetAll}>
            Reset
          </button>
          <button type="button" className="btn" onClick={formatJson} disabled={!!error}>
            Format JSON
          </button>
          <button type="button" className="btn" onClick={copyJson} disabled={!!error}>
            Copy JSON
          </button>
          <button type="button" className="btn primary" onClick={downloadJson} disabled={!!error}>
            Download JSON
          </button>
        </div>
      </header>

      <main className="main">
        <aside className="builder" aria-label="Configuration builder">
          {error && (
            <div className="locked-banner" role="alert">
              The JSON on the right has an error. Fix it there to keep editing with these forms.
            </div>
          )}
          <fieldset className="builder-body" disabled={!!error}>
            <GeneralSettings doc={doc} setField={setField} />
            <ConfigurationsPanel
              doc={doc}
              collapsed={collapsed}
              setCollapsed={setCollapsed}
              addConfig={addConfig}
              deleteConfig={deleteConfig}
              updateConfig={updateConfig}
              openEditor={openEditor}
            />
          </fieldset>
        </aside>

        <section className="json-pane" aria-label="Generated JSON">
          <div className="pane-head">
            <h2>Generated JSON</h2>
            <span className={`pill ${error ? "bad" : "good"}`}>
              <span className="status-dot" />
              {error ? (error.line ? `Invalid · line ${error.line}` : "Invalid") : "Valid JSON"}
            </span>
          </div>

          <div className="editor-wrap">
            <Editor
              height="100%"
              language="json"
              theme="job-dark"
              value={text}
              beforeMount={defineTheme}
              onChange={onEditorChange}
              options={EDITOR_OPTIONS}
              loading={editorLoading}
            />
          </div>

          {error && (
            <div className="error-bar" role="alert">
              <strong>Invalid JSON</strong>
              <span>
                {error.line ? `Line ${error.line}: ` : ""}
                {error.message}
              </span>
              <em>Your last valid configuration is preserved.</em>
            </div>
          )}
        </section>
      </main>

      {modal && doc.configs[modal.key] && (
        <JsonModal
          key={`${modal.key}-${modal.field}`}
          configKey={modal.key}
          field={modal.field}
          initialText={modalInitialText()}
          onCancel={closeModal}
          onSave={(value) => {
            updateConfig(modal.key, { [modal.field]: value });
            closeModal();
            showToast(`${FIELD_META[modal.field].title} saved`);
          }}
          onClear={() => {
            updateConfig(modal.key, { [modal.field]: FIELD_META[modal.field].empty });
            closeModal();
            showToast(`${FIELD_META[modal.field].title} cleared`);
          }}
        />
      )}

      {toast && (
        <div className={`toast ${toast.tone}`} role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}