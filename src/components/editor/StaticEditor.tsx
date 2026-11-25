"use client";
import { useEffect, useMemo, useState } from "react";
import { snapshotDataSchema, type SnapshotData } from "@/lib/data/schema";
import { validateSnapshot } from "@/lib/data/validation";
import { SCHEDULE_DAYS, addDaysIso } from "@/lib/data/validation-helpers";
import { formatLongDate, suggestPeriodLabel, todayIso } from "@/lib/data/dates";
import { CategoriesTab, Field, HistoryTab, MainTab, TextsTab } from "../admin/SnapshotEditor";
import { diffSnapshots, type Change } from "@/lib/data/diff";
import type { Issue } from "@/lib/data/validation";
import { pageHref } from "@/lib/site";
import {
  REPO,
  GitHubError,
  checkAccess,
  deployState,
  forgetVault,
  hasVault,
  openVault,
  readDataFile,
  saveVault,
  vaultLogin,
  writeDataFile,
  type RunState,
} from "./github";

type Entry = {
  revision: number;
  publishedAt: string | null;
  data: SnapshotData;
};
type FileJson = { format: string; version: number; snapshots: Entry[] };

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const byDate = (a: Entry, b: Entry) => (a.data.asOfDate < b.data.asOfDate ? -1 : 1);

/**
 * Editor for the GitHub Pages site. The data lives in data/published/snapshots.json in the
 * repository; publishing = one commit, after which GitHub Actions rebuilds the site and
 * all PNG files. Access = a GitHub token with write access to the site repository (REPO), kept on this
 * device encrypted with the editor password.
 */
export function StaticEditor() {
  const [token, setToken] = useState<string | null>(null);
  const [login, setLogin] = useState<string | null>(null);
  if (!token) return <Gate onReady={(t, l) => (setToken(t), setLogin(l))} />;
  return (
    <Workspace
      token={token}
      login={login ?? "GitHub"}
      onLogout={() => {
        setToken(null);
        setLogin(null);
      }}
    />
  );
}

/* --------------------------------------------------------------------- sign-in */

function Gate({ onReady }: { onReady: (token: string, login: string) => void }) {
  const [mode, setMode] = useState<"password" | "setup" | null>(null);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setMode(hasVault() ? "password" : "setup"), []);

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await openVault(password);
      const l = await checkAccess(t);
      onReady(t, l);
    } catch (e) {
      setError(
        e instanceof GitHubError
          ? e.status === 401
            ? "Ключ доступу більше не дійсний. Попросіть у адміністратора новий і натисніть «Увійти з ключем доступу»."
            : e.message
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };
  const setup = async () => {
    setError(null);
    if (password.length < 10) return setError("Пароль має бути щонайменше 10 символів.");
    if (password !== password2) return setError("Паролі не збігаються.");
    setBusy(true);
    try {
      const t = tokenInput.trim();
      const l = await checkAccess(t);
      await saveVault(t, password, l);
      onReady(t, l);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!mode) return null;
  return (
    <div className="adm-login">
      <div className="adm-card" style={{ width: "min(36rem, 100%)", display: "grid", gap: "1rem" }}>
        <h1
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontSize: "1.5rem",
          }}
        >
          Редактор даних
        </h1>
        {mode === "password" ? (
          <>
            <p className="muted">Введіть пароль, який ви придумали під час першого входу в цьому браузері.</p>
            <Field label="Пароль">
              <input
                className="adm-input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && unlock()}
                autoFocus
              />
            </Field>
            <button className="btn btn--primary" disabled={busy || !password} onClick={unlock}>
              {busy ? "Перевіряю…" : "Увійти"}
            </button>
            <button
              className="btn"
              onClick={() => {
                forgetVault();
                setMode("setup");
                setPassword("");
              }}
            >
              Забули пароль? Увійти з ключем доступу
            </button>
          </>
        ) : (
          <>
            <p className="muted">Перший вхід у цьому браузері. Вставте ключ доступу, який вам дав адміністратор сайту, і придумайте пароль.</p>
            <p className="muted">
              Ключ і пароль зберігаються лише в цьому браузері. На іншому пристрої чи в іншому браузері цей крок потрібно повторити: вставити той самий ключ і
              придумати пароль. Тому збережіть ключ у надійному місці й нікому його не пересилайте.
            </p>
            <Field label="Ключ доступу">
              <input
                className="adm-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Вставте ключ"
              />
            </Field>
            <div className="adm-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Field label="Придумайте пароль" hint="Щонайменше 10 символів. Він потрібен для входу в цьому браузері">
                <input className="adm-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Field label="Повторіть пароль">
                <input className="adm-input" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
              </Field>
            </div>
            <button className="btn btn--primary" disabled={busy || !tokenInput || !password} onClick={setup}>
              {busy ? "Перевіряю доступ…" : "Зберегти й увійти"}
            </button>
          </>
        )}
        {error && (
          <p className="adm-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- workspace */

const STEPS: Array<{ id: Step; title: string; help: string }> = [
  {
    id: "main",
    title: "Головні цифри",
    help: "Загальна кількість злочинів, дата, на яку актуальні дані, нові випадки за останній період, кількість загиблих медійників і посилання на публікації ІМІ. Числа беріть з публікації ІМІ.",
  },
  {
    id: "categories",
    title: "Види порушень",
    help: "14 видів порушень з кругової діаграми та карток. Змініть число біля потрібного виду. Назви та іконки зазвичай не змінюються.",
  },
  {
    id: "history",
    title: "Динаміка по роках",
    help: "Точки графіка «Як змінювалися цифри» і картки років. До кожної точки потрібне посилання на публікацію на imi.org.ua. Поточні дані додаються на графік автоматично.",
  },
  {
    id: "texts",
    title: "Тексти UA/EN",
    help: "Підпис періоду («4 роки і 9 місяців повномасштабної війни») і примітка редакції. Підпис періоду при нових даних заповнюється сам.",
  },
];
type Step = "main" | "categories" | "history" | "texts";
const stepOf = (field?: string): Step =>
  !field ? "main" : field.startsWith("categories") ? "categories" : field.startsWith("history") ? "history" : field.startsWith("texts") ? "texts" : "main";

function Workspace({ token, login, onLogout }: { token: string; login: string; onLogout: () => void }) {
  const [file, setFile] = useState<FileJson | null>(null);
  const [sha, setSha] = useState("");
  const [mode, setMode] = useState<"edit" | "new">("edit");
  const [base, setBase] = useState<SnapshotData | null>(null); // what the edit started from
  const [data, setData] = useState<SnapshotData | null>(null);
  const [step, setStep] = useState<Step>("main");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    commit: string;
    state: RunState;
    asOf: string;
    scheduled?: boolean;
  } | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  const today = todayIso();
  const maxDate = addDaysIso(today, SCHEDULE_DAYS);
  const entries = useMemo(() => (file ? [...file.snapshots].sort(byDate) : []), [file]);
  // What the site shows now: the latest entry not dated in the future. Later entries are
  // scheduled; the daily rebuild puts each one live on its date.
  const live = useMemo(() => [...entries].reverse().find((e) => e.data.asOfDate <= today)?.data ?? entries.at(-1)?.data ?? null, [entries, today]);
  const scheduled = useMemo(() => entries.filter((e) => e.data.asOfDate > today).map((e) => e.data), [entries, today]);

  const load = async () => {
    setBusy(true);
    setLoadError(null);
    try {
      const r = await readDataFile(token);
      const f = r.json as FileJson;
      f.snapshots = f.snapshots.map((x) => ({
        ...x,
        data: snapshotDataSchema.parse(x.data),
      }));
      setFile(f);
      setSha(r.sha);
      const sorted = [...f.snapshots].sort(byDate);
      const now = todayIso();
      const onSite = [...sorted].reverse().find((x) => x.data.asOfDate <= now)?.data ?? sorted.at(-1)!.data;
      setMode("edit");
      setBase(clone(onSite));
      setData(clone(onSite));
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changes = useMemo(() => (data && base ? diffSnapshots(base, data).filter((c) => !c.path.startsWith("verification")) : []), [data, base]);
  const dirty = mode === "new" || changes.length > 0;

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!done || (done.state && done.state.status === "completed")) return;
    const t = setInterval(async () => {
      try {
        const st = await deployState(token, done.commit);
        setDone((r) => (r ? { ...r, state: st } : r));
      } catch {
        clearInterval(t);
      }
    }, 8000);
    return () => clearInterval(t);
  }, [done, token]);

  const previous = useMemo(() => {
    if (!data) return null;
    // The entry being edited is not its own predecessor (moving its date must not compare it with itself).
    const before = entries.filter((e) => e.data.asOfDate < data.asOfDate && !(mode === "edit" && e.data.asOfDate === base?.asOfDate));
    return before.length ? before[before.length - 1]!.data : null;
  }, [entries, data, mode, base]);
  const v = useMemo(
    () =>
      data
        ? validateSnapshot(data, {
            previous,
            today,
            scheduleDays: SCHEDULE_DAYS,
          })
        : null,
    [data, previous, today],
  );
  const isScheduled = !!data && data.asOfDate > today && data.asOfDate <= maxDate;
  // "New data" on the date that is already on the site: one plain message instead of the
  // chart-point error it causes, and a pointer to the right action.
  const sameDayAsLive = mode === "new" && !!data && !!live && data.asOfDate <= live.asOfDate;
  const dataErrors: Issue[] = v
    ? [
        ...(sameDayAsLive
          ? [
              {
                code: "new-same-date",
                severity: "error",
                kind: "data",
                field: "asOfDate",
                message: `Дані станом на ${formatLongDate(live!.asOfDate, "uk")} вже є на сайті. «Додати нові дані» — це цифри на пізнішу дату. Щоб змінити цифри на ${formatLongDate(live!.asOfDate, "uk")}, поверніться й виберіть «Виправити поточні дані»`,
              } as Issue,
            ]
          : []),
        ...v.issues.filter((i) => i.severity === "error" && i.kind !== "gate" && !(sameDayAsLive && (i.code === "history-date" || i.code === "period-order"))),
      ]
    : [];
  const warnings = v ? v.issues.filter((i) => i.severity === "warning") : [];
  // One-click fixes for warnings that have an obvious answer.
  const quickFix = (i: Issue): { label: string; apply: () => void } | null =>
    i.code === "period-end" && data
      ? { label: `Зробити кінцем періоду ${formatLongDate(data.asOfDate, "uk")}`, apply: () => update((d) => void (d.period.end = d.asOfDate)) }
      : null;

  // Any change to figures or texts withdraws the confirmations: they are given again in
  // the review step for exactly what is about to be published.
  const update = (fn: (d: SnapshotData) => void) =>
    setData((prev) => {
      if (!prev) return prev;
      const next = clone(prev);
      fn(next);
      if (next.asOfDate !== prev.asOfDate && /^\d{4}-\d{2}-\d{2}$/.test(next.asOfDate)) {
        // Moving the date moves what depends on it, unless it was set by hand.
        if (prev.period.end === prev.asOfDate) next.period.end = next.asOfDate;
        const was = suggestPeriodLabel(prev.monitoringStart, prev.asOfDate);
        if (prev.texts.periodLabel.uk === was.uk && prev.texts.periodLabel.en === was.en)
          next.texts.periodLabel = suggestPeriodLabel(next.monitoringStart, next.asOfDate);
      }
      const strip = (d: SnapshotData) => JSON.stringify({ ...d, verification: null });
      if (strip(next) !== strip(prev)) {
        next.verification.sourceChecked = false;
        next.verification.sumMismatchConfirmed = false;
      }
      return next;
    });

  const startEdit = (target: SnapshotData | null = live) => {
    if (!target || (dirty && !window.confirm("Незбережені зміни буде втрачено. Продовжити?"))) return;
    setMode("edit");
    setBase(clone(target));
    setData(clone(target));
    setStep("main");
  };
  const startNew = (asOf?: string) => {
    if (!live) return;
    // New data is for a later date than what the site shows. If that is today (or later),
    // default to the next day; to change today's figures there is "Виправити поточні дані".
    if (!asOf) asOf = todayIso() > live.asOfDate ? todayIso() : addDaysIso(live.asOfDate, 1);
    if (mode !== "new" && dirty && !window.confirm("Незбережені зміни буде втрачено. Продовжити?")) return;
    const d = clone(live);
    d.asOfDate = asOf;
    d.period = { start: live.asOfDate, end: asOf, newCases: null };
    d.texts.periodLabel = suggestPeriodLabel(d.monitoringStart, asOf);
    d.verification = {
      ...d.verification,
      sourceChecked: false,
      sumMismatchConfirmed: false,
      internalNote: "",
    };
    // The figures that are on the site now become a point on the dynamics chart.
    if (!d.history.points.some((p) => p.date === live.asOfDate)) {
      d.history.points.push({
        date: live.asOfDate,
        total: live.totalCrimes,
        killedTotal: live.casualties.killedTotal,
        killedOnDuty: live.casualties.killedOnDuty,
        note: { uk: "", en: "" },
        source: live.sources.articleUk,
      });
      d.history.points.sort((a, b) => (a.date < b.date ? -1 : 1));
    }
    setMode("new");
    setBase(clone(live));
    setData(d);
    setStep("main");
  };

  const publish = async () => {
    if (!file || !data) return;
    setBusy(true);
    setPublishError(null);
    try {
      const now = new Date().toISOString();
      const next: FileJson = clone(file);
      // The repository is public: internal notes are not written to it.
      const out: SnapshotData = {
        ...clone(data),
        verification: { ...data.verification, internalNote: "" },
      };
      // Editing what is on the site and moving its date into the future schedules a copy:
      // the current figures stay live until that day.
      const scheduling = out.asOfDate > todayIso();
      const replaceKey = mode === "edit" && !(scheduling && base!.asOfDate <= todayIso()) ? base!.asOfDate : out.asOfDate;
      const at = next.snapshots.findIndex((x) => x.data.asOfDate === replaceKey);
      const clash = next.snapshots.findIndex((x, i) => i !== at && x.data.asOfDate === out.asOfDate);
      if (clash >= 0) {
        setPublishError(
          `На ${formatLongDate(out.asOfDate, "uk")} вже є дані${out.asOfDate > todayIso() ? " (заплановані)" : ""}. Відкрийте їх і змініть там або виберіть іншу дату.`,
        );
        return;
      }
      if (at >= 0)
        next.snapshots[at] = {
          revision: next.snapshots[at]!.revision + 1,
          publishedAt: now,
          data: out,
        };
      else next.snapshots.push({ revision: 1, publishedAt: now, data: out });
      next.snapshots.sort(byDate);
      const what = scheduling ? "заплановано" : mode === "new" ? "нові дані" : "виправлення";
      const r = await writeDataFile(token, next, sha, `Дані станом на ${out.asOfDate}: ${what} (редактор, ${login})`);
      setSha(r.sha);
      setFile(next);
      setMode("edit");
      setBase(clone(out));
      setData(clone(out));
      setReview(false);
      setDone({
        commit: r.commit,
        state: null,
        asOf: out.asOfDate,
        scheduled: scheduling,
      });
    } catch (e) {
      const err = e as GitHubError;
      setPublishError(
        err.status === 409 || err.status === 422
          ? "Хтось інший щойно змінив дані. Закрийте це вікно, натисніть «Завантажити заново» і внесіть зміни ще раз."
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  };

  const cancelScheduled = async (date: string) => {
    if (!file || !window.confirm(`Скасувати заплановану публікацію на ${formatLongDate(date, "uk")}? Ці цифри не з’являться на сайті.`)) return;
    setBusy(true);
    setPublishError(null);
    try {
      const next: FileJson = clone(file);
      next.snapshots = next.snapshots.filter((x) => x.data.asOfDate !== date);
      const r = await writeDataFile(token, next, sha, `Дані станом на ${date}: скасовано заплановану публікацію (редактор, ${login})`);
      setSha(r.sha);
      setFile(next);
      if (data?.asOfDate === date || base?.asOfDate === date) {
        const onSite = [...next.snapshots]
          .sort(byDate)
          .reverse()
          .find((x) => x.data.asOfDate <= todayIso())?.data;
        if (onSite) (setMode("edit"), setBase(clone(onSite)), setData(clone(onSite)));
      }
      setDone(null);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const site = pageHref("uk");
  const help = STEPS.find((x) => x.id === step)!;
  return (
    <div className="adm ed">
      <header className="ed-top">
        <div className="ed-top__inner">
          <b className="ed-top__title">Редактор даних</b>
          {live && (
            <span className="ed-live">
              На сайті зараз: <b>{live.totalCrimes}</b> станом на {formatLongDate(live.asOfDate, "uk")}
            </span>
          )}
          <nav className="ed-top__links">
            <a href={site} target="_blank" rel="noopener">
              Сайт
            </a>
            <button onClick={onLogout}>Вийти</button>
          </nav>
        </div>
      </header>

      <main className="ed-main">
        {!file || !data || !live ? (
          <div className="adm-card">
            {busy ? "Завантажую дані…" : loadError}
            {loadError && (
              <button className="btn" style={{ marginLeft: "1rem" }} onClick={load}>
                <span>Спробувати ще раз</span>
              </button>
            )}
          </div>
        ) : (
          <>
            {done && (
              <div className="ed-done" role="status">
                <b>
                  {done.scheduled
                    ? `Заплановано: дані станом на ${formatLongDate(done.asOf, "uk")} з’являться на сайті цього дня після 00:10.`
                    : `Опубліковано: дані станом на ${formatLongDate(done.asOf, "uk")}.`}
                </b>
                <span>
                  {done.scheduled
                    ? "До того на сайті лишаються поточні цифри. Нічого більше робити не треба."
                    : !done.state || done.state.status !== "completed"
                      ? "Сайт і інфографіка оновлюються, це займає близько 2 хвилин."
                      : done.state.conclusion === "success"
                        ? "Сайт оновлено. Якщо бачите старі цифри, оновіть сторінку."
                        : "Під час оновлення сайту сталася помилка."}{" "}
                  {done.state?.conclusion && done.state.conclusion !== "success" && "Повідомте адміністратора сайту."}
                </span>
              </div>
            )}

            {scheduled.length > 0 && (
              <section className="ed-scheduled" aria-label="Заплановані публікації">
                <h2>Заплановано</h2>
                {scheduled.map((s) => (
                  <div key={s.asOfDate} className="ed-scheduled__row">
                    <span>
                      <b>{formatLongDate(s.asOfDate, "uk")}</b>: загальний показник {s.totalCrimes}. З’явиться на сайті цього дня після 00:10.
                    </span>
                    <button className="btn" disabled={busy} onClick={() => startEdit(s)}>
                      <span>Змінити</span>
                    </button>
                    <button className="btn" disabled={busy} onClick={() => void cancelScheduled(s.asOfDate)}>
                      <span>Скасувати</span>
                    </button>
                  </div>
                ))}
              </section>
            )}

            <section className="ed-mode" aria-label="Що ви хочете зробити">
              <button className="ed-choice" aria-pressed={mode === "edit" && base?.asOfDate === live.asOfDate} onClick={() => startEdit(live)}>
                <b>Виправити поточні дані</b>
                <span>
                  Уточнити цифри станом на {formatLongDate(live.asOfDate, "uk")}. Дату теж можна змінити, зокрема на день уперед: тоді виправлення з’явиться на
                  сайті в цей день.
                </span>
              </button>
              <div className="ed-choice" aria-pressed={mode === "new"} role="group">
                <button className="ed-choice__btn" onClick={() => startNew(data.asOfDate > live.asOfDate ? data.asOfDate : undefined)}>
                  <b>Додати нові дані</b>
                  <span>
                    Нові цифри на обрану дату. Поточні стануть точкою на графіку динаміки. Дату можна вибрати до {SCHEDULE_DAYS} днів уперед: дані з’являться на
                    сайті в цей день автоматично.
                  </span>
                </button>
                {mode === "new" && (
                  <label className="ed-date">
                    Дані станом на
                    <input
                      className="adm-input"
                      type="date"
                      value={data.asOfDate}
                      min={addDaysIso(live.asOfDate, 1)}
                      max={maxDate}
                      onChange={(e) => e.target.value && startNew(e.target.value)}
                    />
                  </label>
                )}
              </div>
            </section>

            <nav className="ed-steps" aria-label="Розділи">
              {STEPS.map((x, i) => {
                const n = v?.issues.filter((iss) => iss.severity === "error" && iss.kind !== "gate" && stepOf(iss.field) === x.id).length ?? 0;
                return (
                  <button key={x.id} aria-current={step === x.id ? "step" : undefined} onClick={() => setStep(x.id)}>
                    <i>{i + 1}</i>
                    <span>{x.title}</span>
                    {n > 0 && <em title="Помилки в розділі">{n}</em>}
                  </button>
                );
              })}
            </nav>
            <p className="ed-help">{help.help}</p>

            {warnings.length > 0 && (
              <section id="ed-warnings" className="ed-issues ed-issues--warn ed-warnings">
                <h3>Зверніть увагу</h3>
                <p className="muted">
                  Попередження не заважають публікації. Це підказка, що щось виглядає незвично: перевірте, і якщо так і має бути, просто публікуйте.
                </p>
                <ul>
                  {warnings.map((i, n) => {
                    const fx = quickFix(i);
                    return (
                      <li key={n}>
                        {i.message}.{" "}
                        {fx && (
                          <button type="button" className="link" onClick={fx.apply}>
                            {fx.label}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <div className="ed-panel">
              {step === "main" && (
                <MainTab data={data} update={update} editable changeNote="" setChangeNote={() => undefined} issues={v?.issues ?? []} hideChangeNote />
              )}
              {step === "categories" && <CategoriesTab data={data} update={update} editable />}
              {step === "history" && <HistoryTab data={data} update={update} editable />}
              {step === "texts" && <TextsTab data={data} update={update} editable />}
            </div>
          </>
        )}
      </main>

      {data && live && (
        <footer className="ed-bar">
          <div className="ed-bar__inner">
            <span className="ed-bar__state">
              {mode === "new"
                ? `Нові дані станом на ${formatLongDate(data.asOfDate, "uk")}`
                : changes.length
                  ? `Змінено полів: ${changes.length}`
                  : "Змін поки немає"}
              {isScheduled && <em className="ed-chip">Буде на сайті {formatLongDate(data.asOfDate, "uk")}</em>}
              {warnings.length > 0 && (
                <button
                  type="button"
                  className="ed-chip ed-chip--warn"
                  onClick={() => document.getElementById("ed-warnings")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                >
                  Попереджень: {warnings.length}
                </button>
              )}
              {dataErrors.length > 0 && <em className="ed-chip ed-chip--err">Помилок: {dataErrors.length}</em>}
            </span>
            {dirty && (
              <button className="btn" onClick={() => startEdit(live)}>
                <span>Скасувати зміни</span>
              </button>
            )}
            <button className="btn btn--primary btn--lg" disabled={!dirty || busy} onClick={() => (setPublishError(null), setReview(true))}>
              <span>{!dirty ? "Немає що публікувати" : isScheduled ? "Перевірити й запланувати" : "Перевірити й опублікувати"}</span>
            </button>
          </div>
        </footer>
      )}

      {review && data && v && (
        <ReviewDialog
          data={data}
          update={update}
          changes={changes}
          isNew={mode === "new"}
          scheduledFor={isScheduled ? data.asOfDate : null}
          liveDate={live?.asOfDate ?? ""}
          dataErrors={dataErrors}
          warnings={warnings}
          quickFix={quickFix}
          sum={v.categorySum}
          busy={busy}
          error={publishError}
          onGo={(f) => (setReview(false), setStep(stepOf(f)))}
          onClose={() => setReview(false)}
          onPublish={publish}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- review */

function ReviewDialog({
  data,
  update,
  changes,
  isNew,
  scheduledFor,
  liveDate,
  dataErrors,
  warnings,
  quickFix,
  sum,
  busy,
  error,
  onGo,
  onClose,
  onPublish,
}: {
  data: SnapshotData;
  update: (fn: (d: SnapshotData) => void) => void;
  changes: Change[];
  isNew: boolean;
  scheduledFor: string | null;
  liveDate: string;
  dataErrors: Issue[];
  warnings: Issue[];
  quickFix?: (i: Issue) => { label: string; apply: () => void } | null;
  sum: number;
  busy: boolean;
  error: string | null;
  onGo: (field?: string) => void;
  onClose: () => void;
  onPublish: () => void;
}) {
  const vf = data.verification;
  const mismatch = sum !== data.totalCrimes;
  const explained = !!vf.sumMismatchExplanation.uk && !!vf.sumMismatchExplanation.en;
  const ready = dataErrors.length === 0 && vf.sourceChecked && (!mismatch || (vf.sumMismatchConfirmed && explained));
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="ed-modal" role="dialog" aria-modal="true" aria-labelledby="ed-review-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ed-modal__box">
        <h2 id="ed-review-title">Перевірка перед публікацією</h2>
        {scheduledFor && (
          <p className="ed-scheduled-note">
            Публікацію буде заплановано: ці дані з’являться на сайті {formatLongDate(scheduledFor, "uk")} після 00:10. До того на сайті лишаються цифри станом
            на {formatLongDate(liveDate, "uk")}.
          </p>
        )}

        <section>
          <h3>
            {isNew
              ? `Нові дані станом на ${formatLongDate(data.asOfDate, "uk")}`
              : scheduledFor
                ? `Що зміниться на сайті ${formatLongDate(scheduledFor, "uk")}`
                : "Що зміниться на сайті"}
          </h3>
          {changes.length === 0 ? (
            <p className="muted">Цифри ті самі, що й зараз на сайті.</p>
          ) : (
            <ul className="ed-changes">
              {changes.slice(0, 40).map((c) => (
                <li key={c.path}>
                  <span>{c.label}</span>
                  <s>{c.before}</s>
                  <b>{c.after}</b>
                </li>
              ))}
              {changes.length > 40 && <li className="muted">і ще {changes.length - 40}</li>}
            </ul>
          )}
        </section>

        {dataErrors.length > 0 && (
          <section className="ed-issues ed-issues--err">
            <h3>Потрібно виправити перед публікацією</h3>
            <ul>
              {dataErrors.map((i, n) => (
                <li key={n}>
                  {i.message}{" "}
                  <button className="link" onClick={() => onGo(i.field)}>
                    Виправити
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {warnings.length > 0 && (
          <section className="ed-issues ed-issues--warn">
            <h3>Зверніть увагу</h3>
            <p className="muted">Попередження не заважають публікації. Якщо так і має бути, публікуйте.</p>
            <ul>
              {warnings.map((i, n) => {
                const fx = quickFix?.(i);
                return (
                  <li key={n}>
                    {i.message}.{" "}
                    {fx && (
                      <button type="button" className="link" onClick={fx.apply}>
                        {fx.label}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="ed-confirm">
          <h3>Підтвердження</h3>
          <label className="ed-check">
            <input type="checkbox" checked={vf.sourceChecked} onChange={(e) => update((d) => void (d.verification.sourceChecked = e.target.checked))} />
            <span>Я звірив(-ла) цифри з публікацією ІМІ.</span>
          </label>
          {mismatch && (
            <>
              <label className="ed-check">
                <input
                  type="checkbox"
                  checked={vf.sumMismatchConfirmed}
                  onChange={(e) => update((d) => void (d.verification.sumMismatchConfirmed = e.target.checked))}
                />
                <span>
                  Сума видів порушень ({sum}) відрізняється від головного показника ({data.totalCrimes}). Я перевірив(-ла): так у публікації ІМІ.
                </span>
              </label>
              {vf.sumMismatchConfirmed && (
                <div className="ed-explain">
                  <Field label="Пояснення для сайту (UA)" hint="Показується в розділі «Про дані»">
                    <textarea
                      className="adm-textarea"
                      maxLength={600}
                      value={vf.sumMismatchExplanation.uk}
                      onChange={(e) => update((d) => void (d.verification.sumMismatchExplanation.uk = e.target.value))}
                    />
                  </Field>
                  <Field label="Пояснення для сайту (EN)">
                    <textarea
                      className="adm-textarea"
                      maxLength={600}
                      value={vf.sumMismatchExplanation.en}
                      onChange={(e) => update((d) => void (d.verification.sumMismatchExplanation.en = e.target.value))}
                    />
                  </Field>
                </div>
              )}
            </>
          )}
        </section>

        {error && (
          <p className="adm-error" role="alert">
            {error}
          </p>
        )}

        <div className="ed-modal__actions">
          <button className="btn" onClick={onClose}>
            <span>Повернутися до редагування</span>
          </button>
          <button className="btn btn--primary btn--lg" disabled={!ready || busy} onClick={onPublish}>
            <span>{busy ? "Зберігаю…" : scheduledFor ? "Запланувати публікацію" : "Опублікувати на сайті"}</span>
          </button>
        </div>
        {!ready && !busy && (
          <p className="muted ed-why">
            {dataErrors.length > 0
              ? "Спершу виправте помилки вище."
              : !vf.sourceChecked
                ? "Поставте позначку, що цифри звірено з публікацією ІМІ."
                : "Підтвердьте розбіжність суми і додайте пояснення обома мовами."}
          </p>
        )}
      </div>
    </div>
  );
}
