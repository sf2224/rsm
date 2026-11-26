import { snapshotDataSchema, visibleCategories, categorySum, type SnapshotData } from "./schema";
import { suggestPeriodLabel, isoCompare, addDaysIso } from "./validation-helpers";
import { formatLongDate } from "./dates";

export type IssueSeverity = "error" | "warning" | "info";
/**
 * - data: problems in the figures/texts themselves (block "submit for review" and publishing)
 * - gate: editorial confirmations still missing (block publishing only)
 * - check: advisory comparisons with the previous publication
 */
export type IssueKind = "data" | "gate" | "check";

export interface Issue {
  code: string;
  severity: IssueSeverity;
  kind: IssueKind;
  field?: string;
  message: string;
}

export interface ValidationContext {
  /** Currently published snapshot for an EARLIER period (for trend checks). */
  previous?: SnapshotData | null;
  /** Today's date (YYYY-MM-DD, Kyiv). */
  today: string;
  /**
   * Days ahead a publication may be dated (static editor scheduling). The site build
   * passes 0: an entry dated in the future is held back until that day.
   */
  scheduleDays?: number;
}

export interface ValidationResult {
  issues: Issue[];
  /** Parsed data if the document passed the schema. */
  data: SnapshotData | null;
  canSubmit: boolean;
  canPublish: boolean;
  categorySum: number;
  total: number;
}

const fmt = (n: number) => n.toLocaleString("uk-UA");

export function validateSnapshot(input: unknown, ctx: ValidationContext): ValidationResult {
  const issues: Issue[] = [];
  const parsed = snapshotDataSchema.safeParse(input);
  if (!parsed.success) {
    for (const e of parsed.error.issues) {
      issues.push({ code: "schema", severity: "error", kind: "data", field: e.path.join("."), message: e.message });
    }
    return { issues, data: null, canSubmit: false, canPublish: false, categorySum: 0, total: 0 };
  }
  const d = parsed.data;
  const err = (code: string, message: string, field?: string, kind: IssueKind = "data") => issues.push({ code, severity: "error", kind, field, message });
  const warn = (code: string, message: string, field?: string) => issues.push({ code, severity: "warning", kind: "check", field, message });
  const info = (code: string, message: string, field?: string) => issues.push({ code, severity: "info", kind: "check", field, message });

  // ---- Dates -------------------------------------------------------------
  if (isoCompare(d.asOfDate, d.monitoringStart) <= 0) err("dates-order", "Дата актуальності має бути пізніше за початок моніторингу", "asOfDate");
  if (isoCompare(d.asOfDate, ctx.today) > 0) {
    const days = ctx.scheduleDays ?? 0;
    if (days > 0 && isoCompare(d.asOfDate, addDaysIso(ctx.today, days)) <= 0)
      info("scheduled", "Дата в майбутньому: дані з’являться на сайті автоматично в цей день", "asOfDate");
    else
      err(
        "dates-future",
        days > 0 ? `Запланувати публікацію можна не далі ніж на ${days} днів уперед` : "Дата актуальності не може бути в майбутньому",
        "asOfDate",
      );
  }
  const { start, end, newCases } = d.period;
  if ((start === null) !== (end === null)) err("period-incomplete", "Вкажіть обидві дати звітного періоду або жодної", "period");
  if (start && end) {
    if (isoCompare(start, end) >= 0) err("period-order", "Початок звітного періоду має бути раніше за кінець", "period.start");
    if (isoCompare(start, d.monitoringStart) < 0) err("period-before-start", "Звітний період не може починатися до початку моніторингу", "period.start");
    if (end !== d.asOfDate)
      warn(
        "period-end",
        `Звітний період закінчується ${formatLongDate(end, "uk")}, а дані — станом на ${formatLongDate(d.asOfDate, "uk")}. Зазвичай це одна дата`,
        "period.end",
      );
  }
  if (newCases !== null && !start) warn("new-cases-no-period", "Кількість нових випадків вказана без звітного періоду", "period.newCases");
  if (newCases !== null && newCases > d.totalCrimes) err("new-cases-gt-total", "Нових випадків не може бути більше за загальний показник", "period.newCases");

  // ---- Casualties --------------------------------------------------------
  const { killedTotal, killedOnDuty } = d.casualties;
  if (killedTotal !== null && killedOnDuty !== null && killedOnDuty > killedTotal)
    err("killed-order", "Загиблих під час роботи не може бути більше, ніж загиблих загалом", "casualties.killedOnDuty");
  const killings = d.categories.find((c) => c.id === "killings" && !c.hidden);
  if (killings && killedOnDuty !== null && killings.value !== killedOnDuty)
    warn(
      "killings-vs-on-duty",
      `Категорія «Вбивства» (${killings.value}) не збігається з кількістю загиблих під час роботи (${killedOnDuty})`,
      "casualties.killedOnDuty",
    );

  // ---- Categories ---------------------------------------------------------
  const visible = visibleCategories(d);
  if (visible.length === 0) err("no-categories", "Немає жодної видимої категорії", "categories");
  const ids = new Set<string>();
  d.categories.forEach((c, i) => {
    if (ids.has(c.id)) err("category-duplicate", `Ідентифікатор категорії «${c.id}» повторюється`, `categories.${i}.id`);
    ids.add(c.id);
    if (!c.hidden) {
      if (!c.name.uk) err("translation-missing", `Категорія «${c.id}»: немає української назви`, `categories.${i}.name.uk`);
      if (!c.name.en) err("translation-missing", `Категорія «${c.id}»: немає англійської назви`, `categories.${i}.name.en`);
      if (!!c.description.uk !== !!c.description.en)
        warn("description-one-language", `Категорія «${c.id}»: пояснення заповнене лише однією мовою`, `categories.${i}.description`);
    }
  });
  const orders = visible.map((c) => c.order);
  if (new Set(orders).size !== orders.length) warn("order-duplicate", "Кілька категорій мають однаковий порядок відображення", "categories");

  // ---- Texts & sources -------------------------------------------------------
  if (!d.texts.periodLabel.uk) err("translation-missing", "Немає української назви періоду", "texts.periodLabel.uk");
  if (!d.texts.periodLabel.en) err("translation-missing", "Немає англійської назви періоду", "texts.periodLabel.en");
  const suggestion = suggestPeriodLabel(d.monitoringStart, d.asOfDate);
  if (d.texts.periodLabel.uk && d.texts.periodLabel.uk !== suggestion.uk)
    info("period-label-differs", `Назва періоду відрізняється від розрахованої за датами: «${suggestion.uk}»`, "texts.periodLabel.uk");
  if (!!d.texts.editorNote.uk !== !!d.texts.editorNote.en) err("translation-missing", "Примітка редакції заповнена лише однією мовою", "texts.editorNote");
  if (!d.sources.articleUk) err("source-missing", "Додайте посилання на українську публікацію ІМІ", "sources.articleUk");
  if (!d.sources.articleEn) warn("source-en-missing", "Немає посилання на англійську публікацію ІМІ", "sources.articleEn");
  for (const [k, v] of Object.entries(d.sources)) {
    if (v && !/^https:\/\/(www\.)?imi\.org\.ua\//.test(v)) warn("source-domain", `Посилання ${k} веде не на imi.org.ua`, `sources.${k}`);
  }

  // ---- History (dynamics chart) -------------------------------------------------
  const pts = d.history.points;
  pts.forEach((p, i) => {
    if (!p.source) err("history-source", `Динаміка, ${p.date}: додайте посилання на джерело`, `history.points.${i}.source`);
    if (p.date === d.asOfDate)
      err(
        "history-same-day",
        `Графік динаміки: точка ${formatLongDate(p.date, "uk")} повторює поточні дані сайту. Графік і так показує поточні дані останньою точкою, тому цю точку треба видалити`,
        `history.points.${i}.date`,
      );
    else if (isoCompare(p.date, d.asOfDate) > 0)
      err(
        "history-date",
        `Графік динаміки: точка ${p.date} не може бути пізніше за дату «станом на» (${d.asOfDate}). Змініть дату «станом на» або цю точку в розділі «Динаміка»`,
        `history.points.${i}.date`,
      );
    if (isoCompare(p.date, d.monitoringStart) < 0) err("history-date", `Динаміка, ${p.date}: дата раніше за початок моніторингу`, `history.points.${i}.date`);
    if (i > 0 && isoCompare(pts[i - 1]!.date, p.date) >= 0)
      err("history-order", `Динаміка: точки мають іти за зростанням дат (${p.date})`, `history.points.${i}.date`);
    if (!!p.note.uk !== !!p.note.en) err("translation-missing", `Динаміка, ${p.date}: примітка лише однією мовою`, `history.points.${i}.note`);
  });
  const lastTotal = [...pts].reverse().find((p) => p.total !== null)?.total;
  if (lastTotal != null && lastTotal > d.totalCrimes)
    warn("history-gt-total", `В історії є значення ${lastTotal}, більше за поточний показник ${d.totalCrimes}`, "history.points");
  const yrs = d.history.years.map((y) => y.year);
  if (new Set(yrs).size !== yrs.length) err("history-years", "Рік в історії повторюється", "history.years");
  d.history.years.forEach((y, i) => {
    if (!y.source) err("history-source", `Рік ${y.year}: додайте посилання на джерело`, `history.years.${i}.source`);
    if (!!y.note.uk !== !!y.note.en) err("translation-missing", `Рік ${y.year}: опис лише однією мовою`, `history.years.${i}.note`);
  });

  // ---- Sum vs total (never auto-corrected) ---------------------------------
  const sum = categorySum(d);
  if (sum !== d.totalCrimes) {
    const diff = sum - d.totalCrimes;
    const msg = `Сума категорій ${fmt(sum)} ≠ головний показник ${fmt(d.totalCrimes)} (різниця ${diff > 0 ? "+" : ""}${diff}).`;
    const v = d.verification;
    if (!v.sumMismatchConfirmed) {
      err("sum-mismatch", `${msg} Перевірте першоджерело і підтвердьте методологічну причину розбіжності.`, "verification.sumMismatchConfirmed", "gate");
    } else if (!v.sumMismatchExplanation.uk || !v.sumMismatchExplanation.en) {
      err("sum-mismatch-explanation", `${msg} Додайте пояснення розбіжності українською та англійською.`, "verification.sumMismatchExplanation", "gate");
    } else {
      info("sum-mismatch-confirmed", `${msg} Розбіжність підтверджена редактором.`, "verification");
    }
  }
  if (!d.verification.sourceChecked) err("source-not-checked", "Підтвердіть, що цифри звірено з публікацією ІМІ", "verification.sourceChecked", "gate");

  // ---- Comparison with the previous publication ------------------------------
  const prev = ctx.previous;
  if (prev && isoCompare(prev.asOfDate, d.asOfDate) < 0) {
    if (d.totalCrimes < prev.totalCrimes)
      warn("total-decreased", `Головний показник зменшився: ${fmt(prev.totalCrimes)} → ${fmt(d.totalCrimes)}`, "totalCrimes");
    const expectedNew = d.totalCrimes - prev.totalCrimes;
    if (newCases !== null && newCases !== expectedNew)
      warn("new-cases-vs-delta", `Нових випадків ${newCases}, а різниця з попереднім знімком ${expectedNew}`, "period.newCases");
    for (const c of visible) {
      const p = prev.categories.find((x) => x.id === c.id);
      if (p && c.value < p.value) warn("category-decreased", `«${c.name.uk}»: значення зменшилося ${p.value} → ${c.value}`, `categories.${c.id}`);
    }
    if (prev.casualties.killedTotal !== null && d.casualties.killedTotal !== null && d.casualties.killedTotal < prev.casualties.killedTotal)
      warn("killed-decreased", "Кількість загиблих медійників зменшилася порівняно з попереднім знімком", "casualties.killedTotal");
  }

  const hasDataErrors = issues.some((i) => i.severity === "error" && i.kind === "data");
  const hasAnyErrors = issues.some((i) => i.severity === "error");
  return { issues, data: d, canSubmit: !hasDataErrors, canPublish: !hasAnyErrors, categorySum: sum, total: d.totalCrimes };
}
