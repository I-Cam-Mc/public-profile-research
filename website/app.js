import {
  buildPortablePrompt,
  createResearchBrief
} from "./lib/research-brief.mjs";

document.documentElement.classList.remove("no-js");
document.documentElement.classList.add("js");

const ui = {
  header: document.querySelector("[data-header]"),
  engineNotice: document.querySelector("#engine-notice"),
  engineTitle: document.querySelector("#engine-title"),
  engineCopy: document.querySelector("#engine-copy"),
  form: document.querySelector("#research-form"),
  subjectName: document.querySelector("#subject-name"),
  profileUrls: document.querySelector("#profile-urls"),
  identityConfirmed: document.querySelector("#identity-confirmed"),
  profileError: document.querySelector("#profile-error"),
  purpose: document.querySelector("#purpose"),
  customInstructions: document.querySelector("#custom-instructions"),
  instructionsError: document.querySelector("#instructions-error"),
  primaryAction: document.querySelector("#primary-action"),
  primaryLabel: document.querySelector("#primary-action span:first-child"),
  previewBrief: document.querySelector("#preview-brief"),
  modeNote: document.querySelector("#form-mode-note"),
  guidedTab: document.querySelector("#guided-tab"),
  fieldsTab: document.querySelector("#fields-tab"),
  guidedSummary: document.querySelector("#guided-summary"),
  fullFields: document.querySelector("#full-fields"),
  summaryPurpose: document.querySelector("#summary-purpose"),
  summaryDepth: document.querySelector("#summary-depth"),
  summaryMode: document.querySelector("#summary-mode"),
  summaryModules: document.querySelector("#summary-modules"),
  researchMode: document.querySelector("#research-mode"),
  guideThread: document.querySelector("#guide-thread"),
  guideChoices: document.querySelector("#guide-choices"),
  guideCount: document.querySelector("#guide-count"),
  restartGuide: document.querySelector("#restart-guide"),
  guideNote: document.querySelector("#guide-note"),
  addGuideNote: document.querySelector("#add-guide-note"),
  guideNoteStatus: document.querySelector("#guide-note-status"),
  results: document.querySelector("#research-results"),
  resultsTitle: document.querySelector("#results-title"),
  resultState: document.querySelector("#result-state"),
  resultsBody: document.querySelector("#results-body")
};

const purposeLabels = {
  self_audit: "Understand my own public footprint",
  founder_diligence: "Research a founder",
  investor_diligence: "Research an investor",
  dating_safety: "Assess someone I may meet",
  marketplace_safety: "Assess a marketplace contact",
  journalism: "Support public-interest reporting",
  general: "General public-profile research"
};

const depthLabels = {
  quick: "Quick public scan",
  standard: "Standard cross-source review",
  deep: "Deep public corpus review",
  maximum: "Maximum declared public scope"
};

const researchModeLabels = {
  insight: "Answer the named questions",
  bounded_census: "Count a stated boundary",
  maximum_public_coverage: "Exhaust configured public routes"
};

const moduleLabels = {
  identity: "Identity",
  current_activity: "Current activity",
  timeline: "Timeline",
  career: "Career",
  projects: "Projects",
  companies: "Companies and roles",
  public_impression: "Public impression",
  public_persona: "Public persona",
  credibility: "Claim-specific credibility",
  controversies: "Known controversies",
  professional_network: "Public professional network",
  media: "Video, audio and posts",
  code: "Public code",
  commercial_activity: "Commercial activity"
};

const guidePresets = {
  work: ["identity", "current_activity", "timeline", "career", "companies", "projects", "credibility"],
  public_presence: ["identity", "current_activity", "timeline", "public_impression", "public_persona", "media"],
  safety: ["identity", "current_activity", "timeline", "credibility", "controversies"],
  broad: Object.keys(moduleLabels)
};

const initialGuideMarkup = ui.guideThread.innerHTML;
let engineMode = "checking";
let guideStep = 1;
let latestBrief = null;
let latestPrompt = "";

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function setEngineMode(mode, detail = "") {
  engineMode = mode;
  ui.engineNotice.className = `engine-notice ${mode}`;
  ui.primaryAction.disabled = false;

  if (mode === "connected") {
    ui.engineTitle.textContent = "Research engine connected";
    ui.engineCopy.textContent = detail || "This page can send the confirmed brief to the public research engine and display its coverage record.";
    ui.primaryLabel.textContent = "Start public research";
    ui.modeNote.textContent = "Starts one bounded run using the scope above. Built-in routes use no project checkout or paid API key. External services can impose quotas or change terms, so check before a large run.";
    return;
  }

  ui.engineTitle.textContent = "Static export mode";
  ui.engineCopy.textContent = "No research engine is connected to this page. It can still export a complete intake and portable AI prompt, but it cannot claim that research has run.";
  ui.primaryLabel.textContent = "Create portable research pack";
  ui.modeNote.textContent = "Creates files on this device only. Use them with the open-source runner or a supported AI system.";
}

function capabilitySummary(value) {
  const summary = value?.summary?.text;
  return typeof summary === "string" && summary.trim()
    ? ` ${summary.trim()}`
    : " Capability checks are still running; unavailable routes will remain visible in the result.";
}

async function refreshCapabilities() {
  try {
    const response = await fetch("/api/capabilities", { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    if (engineMode === "connected") setEngineMode("connected", `The local research engine is ready.${capabilitySummary(payload.capabilities)}`);
  } catch {
    // Collection still reports missing routes individually when preflight is unavailable.
  }
}

async function probeEngine() {
  if (window.location.protocol === "file:") {
    setEngineMode("static");
    return;
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch("/api/health", {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Health check returned ${response.status}`);
    const health = await response.json();
    const available = health?.research === true || health?.research_engine === "available" || health?.status === "ok";
    if (!available) throw new Error("Research capability was not declared by the server");
    setEngineMode("connected", `The local research engine is ready.${capabilitySummary(health.capabilities)}`);
    if (!health.capabilities) void refreshCapabilities();
  } catch {
    setEngineMode("static");
  } finally {
    window.clearTimeout(timer);
  }
}

function selectedDepth() {
  return ui.form.querySelector('input[name="depth"]:checked')?.value || "quick";
}

function selectedRelationship() {
  return ui.form.querySelector('input[name="relationship"]:checked')?.value || "third_party";
}

function selectedModules() {
  const values = [...ui.form.querySelectorAll('input[name="modules"]:checked')].map((input) => input.value);
  if (!values.includes("identity")) values.unshift("identity");
  return [...new Set(values)];
}

function profileUrls() {
  return ui.profileUrls.value
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function clearErrors() {
  for (const [field, error] of [[ui.profileUrls, ui.profileError], [ui.customInstructions, ui.instructionsError]]) {
    field.removeAttribute("aria-invalid");
    field.removeAttribute("aria-describedby");
    error.hidden = true;
    error.textContent = "";
  }
}

function showFieldError(field, error, message) {
  field.setAttribute("aria-invalid", "true");
  field.setAttribute("aria-describedby", error.id);
  error.textContent = message;
  error.hidden = false;
  field.focus();
}

function createBriefFromForm() {
  clearErrors();
  const urls = profileUrls();
  if (!urls.length) {
    showFieldError(ui.profileUrls, ui.profileError, "Add at least one public profile URL to begin.");
    throw new TypeError("A public profile URL is required");
  }

  try {
    const brief = createResearchBrief({
      subjectName: ui.subjectName.value,
      profileUrls: urls,
      identityStatus: ui.identityConfirmed.checked ? "confirmed" : "unconfirmed",
      purpose: ui.purpose.value,
      relationshipToSubject: selectedRelationship(),
      depth: selectedDepth(),
      researchMode: ui.researchMode.value,
      modules: selectedModules(),
      customInstructions: ui.customInstructions.value
    });
    latestBrief = brief;
    latestPrompt = buildPortablePrompt(brief);
    return brief;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/custom instructions|address|diagnos|private|precise location/i.test(message)) {
      showFieldError(ui.customInstructions, ui.instructionsError, message);
    } else {
      showFieldError(ui.profileUrls, ui.profileError, message);
    }
    throw error;
  }
}

function humanise(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function updateSummary() {
  ui.summaryPurpose.textContent = purposeLabels[ui.purpose.value] || humanise(ui.purpose.value);
  ui.summaryDepth.textContent = depthLabels[selectedDepth()] || humanise(selectedDepth());
  ui.summaryMode.textContent = researchModeLabels[ui.researchMode.value] || humanise(ui.researchMode.value);
  const labels = selectedModules().map((value) => moduleLabels[value] || humanise(value));
  ui.summaryModules.textContent = labels.join(", ");
}

function setView(view, focusPanel = false) {
  const guided = view === "guided";
  ui.guidedTab.setAttribute("aria-selected", String(guided));
  ui.fieldsTab.setAttribute("aria-selected", String(!guided));
  ui.guidedSummary.hidden = !guided;
  ui.fullFields.hidden = guided;
  if (focusPanel) (guided ? ui.guidedSummary : ui.fullFields).focus?.();
}

function appendGuideMessage(role, text) {
  const message = textElement("div", `message ${role === "Guide" ? "assistant-message" : "user-message"}`, "");
  message.append(textElement("span", "speaker", role));
  message.append(textElement("p", "", text));
  ui.guideThread.append(message);
  message.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function replaceGuideChoices(choices) {
  ui.guideChoices?.remove();
  const container = textElement("div", "guide-choices", "");
  container.id = "guide-choices";
  for (const choice of choices) {
    const button = textElement("button", "", choice.label);
    button.type = "button";
    for (const [key, value] of Object.entries(choice.data)) button.dataset[key] = value;
    container.append(button);
  }
  ui.guideThread.append(container);
  ui.guideChoices = container;
}

function choosePurpose(button) {
  const purpose = button.dataset.guidePurpose;
  ui.purpose.value = purpose;
  const relationship = purpose === "self_audit" ? "self" : "third_party";
  const relationshipInput = ui.form.querySelector(`input[name="relationship"][value="${relationship}"]`);
  if (relationshipInput) relationshipInput.checked = true;
  appendGuideMessage("You", button.textContent);
  appendGuideMessage("Guide", "How much time and material should this run spend collecting?");
  replaceGuideChoices([
    { label: "Quick snapshot", data: { guideDepth: "quick" } },
    { label: "Standard review", data: { guideDepth: "standard" } },
    { label: "Deep review", data: { guideDepth: "deep" } },
    { label: "Maximum collection budget", data: { guideDepth: "maximum" } }
  ]);
  guideStep = 2;
  ui.guideCount.textContent = "2 / 4";
  updateSummary();
}

function chooseDepth(button) {
  const depth = button.dataset.guideDepth;
  const input = ui.form.querySelector(`input[name="depth"][value="${depth}"]`);
  if (input) input.checked = true;
  appendGuideMessage("You", button.textContent);
  appendGuideMessage("Guide", "The ordinary browser can currently close insight runs. Census and maximum coverage remain advanced contract modes until a denominator enumeration receipt is supplied by an integration.");
  replaceGuideChoices([
    { label: "Answer my questions with visible sampling", data: { guideMode: "insight" } }
  ]);
  guideStep = 3;
  ui.guideCount.textContent = "3 / 4";
  updateSummary();
}

function chooseResearchMode(button) {
  ui.researchMode.value = button.dataset.guideMode;
  appendGuideMessage("You", button.textContent);
  appendGuideMessage("Guide", "Which set of questions should lead the report? You can still tune every module afterwards.");
  replaceGuideChoices([
    { label: "Work and credibility", data: { guidePreset: "work" } },
    { label: "Media and public presence", data: { guidePreset: "public_presence" } },
    { label: "Safety and contradictions", data: { guidePreset: "safety" } },
    { label: "Broad public picture", data: { guidePreset: "broad" } }
  ]);
  guideStep = 4;
  ui.guideCount.textContent = "4 / 4";
  updateSummary();
}

function choosePreset(button) {
  const preset = guidePresets[button.dataset.guidePreset] || guidePresets.broad;
  for (const input of ui.form.querySelectorAll('input[name="modules"]')) {
    input.checked = input.value === "identity" || preset.includes(input.value);
  }
  appendGuideMessage("You", button.textContent);
  appendGuideMessage("Guide", "The brief is shaped. Add a profile URL, then start the run or create the portable research pack. Open all fields if you want to change any choice.");
  ui.guideChoices?.remove();
  ui.guideChoices = null;
  updateSummary();
}

function restartGuide() {
  ui.guideThread.innerHTML = initialGuideMarkup;
  ui.guideChoices = ui.guideThread.querySelector("#guide-choices");
  ui.guideCount.textContent = "1 / 4";
  guideStep = 1;
  ui.purpose.value = "self_audit";
  const relationship = ui.form.querySelector('input[name="relationship"][value="self"]');
  if (relationship) relationship.checked = true;
  const quick = ui.form.querySelector('input[name="depth"][value="quick"]');
  if (quick) quick.checked = true;
  ui.researchMode.value = "insight";
  const defaults = new Set(["identity", "current_activity", "timeline", "public_impression"]);
  for (const input of ui.form.querySelectorAll('input[name="modules"]')) input.checked = defaults.has(input.value);
  updateSummary();
}

function addGuideDirection() {
  const note = ui.guideNote.value.trim();
  if (!note) {
    ui.guideNoteStatus.textContent = "Write a public claim or question first.";
    return;
  }
  const current = ui.customInstructions.value.trim();
  ui.customInstructions.value = current ? `${current}\n${note}` : note;
  appendGuideMessage("You", note);
  appendGuideMessage("Guide", "Added to the research direction. The engine will still apply the public-source and evidence rules.");
  ui.guideNote.value = "";
  ui.guideNoteStatus.textContent = "Direction added.";
}

function safeFilename(value) {
  return String(value || "public-profile")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "public-profile";
}

export function downloadJson(value, filename) {
  downloadBlob(`${JSON.stringify(value, null, 2)}\n`, "application/json", filename);
}

export function downloadText(value, filename) {
  downloadBlob(value, "text/plain;charset=utf-8", filename);
}

function downloadBlob(value, type, filename) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

async function copyPrompt(statusNode) {
  try {
    await navigator.clipboard.writeText(latestPrompt);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = latestPrompt;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  statusNode.textContent = "AI prompt copied.";
}

function setResultsState(kind, title, label) {
  ui.results.className = `research-results ${kind}`;
  ui.resultsTitle.textContent = title;
  ui.resultState.textContent = label;
  ui.resultsBody.replaceChildren();
}

function appendBriefFacts(container, brief) {
  const facts = textElement("dl", "result-facts", "");
  const values = [
    ["Subject", brief.subject.display_name],
    ["Purpose", purposeLabels[brief.purpose] || humanise(brief.purpose)],
    ["Depth", depthLabels[brief.depth] || humanise(brief.depth)],
    ["Public anchors", String(brief.subject.identity_anchors.length)]
  ];
  for (const [term, value] of values) {
    const cell = document.createElement("div");
    cell.append(textElement("dt", "", term), textElement("dd", "", value));
    facts.append(cell);
  }
  container.append(facts);
}

function sameOriginReportUrl(value) {
  if (!value) return null;
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/runs/")) {
    throw new Error("The research server returned an invalid report URL");
  }
  return `${url.pathname}${url.search}`;
}

function resultActions(brief, reportUrl = null) {
  const wrapper = textElement("div", "result-actions", "");
  const stem = safeFilename(brief.subject.display_name);
  if (reportUrl) {
    const report = textElement("a", "button button-primary", "Open generated report");
    report.href = sameOriginReportUrl(reportUrl);
    report.target = "_blank";
    report.rel = EXTERNAL_LINK_REL;
    wrapper.append(report);
  }
  const downloadIntake = textElement("button", "button button-dark", "Download intake JSON");
  downloadIntake.type = "button";
  downloadIntake.addEventListener("click", () => downloadJson(brief, `${stem}-intake.json`));

  const copy = textElement("button", "button button-secondary", "Copy portable AI prompt");
  copy.type = "button";
  const downloadPrompt = textElement("button", "button button-secondary", "Download AI prompt");
  downloadPrompt.type = "button";
  downloadPrompt.addEventListener("click", () => downloadText(latestPrompt, `${stem}-research-prompt.txt`));
  const status = textElement("p", "copy-status", "");
  status.setAttribute("aria-live", "polite");
  copy.addEventListener("click", () => copyPrompt(status));
  wrapper.append(downloadIntake, copy, downloadPrompt, status);
  return wrapper;
}

function renderPortableBrief(brief, label = "Ready to export") {
  setResultsState("completed", "Portable research pack ready", label);
  const summary = textElement("div", "result-summary", "");
  const copy = document.createElement("div");
  copy.append(
    textElement("h4", "", `${brief.subject.display_name}: bounded public research`),
    textElement("p", "", "Research has not run in this browser. The intake records the requested scope and the prompt tells a compatible AI or the open-source runner how to perform the collection and preserve evidence.")
  );
  appendBriefFacts(copy, brief);
  summary.append(copy, resultActions(brief));
  ui.resultsBody.append(summary);
  ui.results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderProgress(brief) {
  setResultsState("loading", `Researching ${brief.subject.display_name}`, "Running");
  const intro = textElement("p", "empty-copy", "The engine is collecting only the declared public targets. This page will keep partial results and explain any source barrier.");
  const list = textElement("ol", "progress-list", "");
  for (const [index, text] of [
    "Confirming the research contract",
    "Collecting supplied sources and public discovery leads",
    "Normalising source items and writing evidence receipts",
    "Synthesising the source-linked report"
  ].entries()) {
    const item = textElement("li", index === 0 ? "active" : "", "");
    item.append(textElement("span", "progress-dot", ""), textElement("span", "", text));
    list.append(item);
  }
  ui.resultsBody.append(intro, list);
  ui.results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderRun(run, brief) {
  const status = run?.status === "completed" ? "completed" : run?.status === "failed" ? "error" : "partial";
  const targets = Array.isArray(run?.targets) ? run.targets : [];
  const collected = targets.filter((target) => target.status === "collected").length;
  const goalSatisfied = run?.closure?.research_mode?.satisfied === true || run?.research_mode_satisfied === true;
  const moduleRequirementsSatisfied = run?.closure?.module_requirements?.satisfied !== false;
  const moduleGaps = Array.isArray(run?.closure?.gaps?.module_requirements)
    ? run.closure.gaps.module_requirements
    : [];
  const identityStatus = run?.identity?.status || run?.research_brief?.subject?.identity_status || brief.subject.identity_status || "unconfirmed";
  const identityConfirmed = identityStatus === "confirmed";
  const title = status === "error"
    ? "No useful subject evidence was collected"
    : status === "completed" && goalSatisfied && identityConfirmed && moduleRequirementsSatisfied
      ? "All required research gates satisfied"
      : goalSatisfied && identityConfirmed && !moduleRequirementsSatisfied
        ? "Requested analysis remains open"
      : goalSatisfied
        ? "Collection goal satisfied, identity remains open"
      : "Research goal remains open";
  setResultsState(status, title, humanise(run?.status || "partial"));

  const summary = textElement("div", "result-summary", "");
  const details = document.createElement("div");
  details.append(
    textElement("h4", "", `${brief.subject.display_name}: ${collected} of ${targets.length || brief.subject.identity_anchors.length} targets collected`),
    textElement("p", "", goalSatisfied
      ? !moduleRequirementsSatisfied
        ? `The ${humanise(brief.research_mode)} collection goal was satisfied from the supplied material. Requested analysis remains open: ${moduleGaps.map((gap) => humanise(gap.module)).join(", ") || "one or more contract requirements"}. The report preserves the specific evidence or modality gap.`
        : `The ${humanise(brief.research_mode)} collection goal was satisfied from the supplied material. ${identityConfirmed ? "Identity is confirmed by the intake or corroborating evidence." : "Identity still needs confirmation before the overall run can close."} Optional discovery gaps, if any, remain in the report.`
      : "Some supplied sources were partial or unavailable, or the selected coverage goal could not be closed. Those gaps remain attached to the report.")
  );
  details.append(textElement("p", "identity-state", `Identity status: ${humanise(identityStatus)}. Source collection is not identity confirmation.`));

  const targetList = textElement("ul", "target-list", "");
  const renderedTargets = targets.length ? targets : brief.subject.identity_anchors.map((url) => ({ canonical_url: url, platform: "public source", status: "partial" }));
  for (const target of renderedTargets) {
    const item = document.createElement("li");
    item.append(textElement("span", "", humanise(target.platform || "source")));
    const link = textElement("a", "", target.canonical_url || "Source URL unavailable");
    if (target.canonical_url) {
      link.href = target.canonical_url;
      link.target = "_blank";
      link.rel = EXTERNAL_LINK_REL;
    }
    item.append(link, textElement("span", `target-status ${target.status || "partial"}`, humanise(target.status || "partial")));
    targetList.append(item);
  }
  details.append(targetList);
  appendBriefFacts(details, brief);
  summary.append(details, resultActions(brief, run.report_url));
  ui.resultsBody.append(summary);
  ui.results.scrollIntoView({ behavior: "smooth", block: "start" });
}

const EXTERNAL_LINK_REL = "noreferrer";

function renderRunError(error) {
  setResultsState("error", "The research run did not complete", "Action needed");
  const message = error instanceof Error ? error.message : String(error);
  const copy = textElement("div", "", "");
  copy.append(
    textElement("p", "empty-copy", `${message}. Your intake is still here. Try the run again, or preview and export the same brief for another research environment.`)
  );
  ui.resultsBody.append(copy);
  ui.results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function sameOriginStatusUrl(value, runId) {
  const fallback = `/api/research/${encodeURIComponent(runId)}`;
  const candidate = value || fallback;
  const url = new URL(candidate, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error("The research server returned an external status URL");
  return `${url.pathname}${url.search}`;
}

function terminalRun(value) {
  return ["completed", "partial", "failed", "cancelled"].includes(value?.status);
}

async function waitForRun(initial) {
  const runId = initial.run_id || initial.id;
  if (!runId) return initial.run || initial;
  const statusUrl = sameOriginStatusUrl(initial.status_url, runId);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(1500 + attempt * 80, 5000)));
    const response = await fetch(statusUrl, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Research status check returned ${response.status}`);
    const payload = await response.json();
    const run = payload.run || payload;
    if (terminalRun(run)) return run;
  }
  throw new Error("The research run is still pending after the browser wait limit");
}

async function runResearchViaApi(brief) {
  renderProgress(brief);
  const response = await fetch("/api/research", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(brief)
  });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload.message || payload.error || "";
    } catch {
      detail = "";
    }
    throw new Error(detail || `Research request returned ${response.status}`);
  }
  const payload = await response.json();
  const run = terminalRun(payload.run || payload) ? (payload.run || payload) : await waitForRun(payload);
  if (run.status === "failed" || run.status === "cancelled") throw new Error(run.message || `Research run ${run.status}`);
  renderRun(run, brief);
}

function setBusy(busy) {
  ui.form.setAttribute("aria-busy", String(busy));
  ui.primaryAction.classList.toggle("is-busy", busy);
  ui.primaryAction.disabled = busy;
  ui.previewBrief.disabled = busy;
}

async function submitResearch(event) {
  event.preventDefault();
  let brief;
  try {
    brief = createBriefFromForm();
  } catch {
    return;
  }

  if (engineMode !== "connected") {
    renderPortableBrief(brief);
    return;
  }

  setBusy(true);
  try {
    await runResearchViaApi(brief);
  } catch (error) {
    renderRunError(error);
  } finally {
    setBusy(false);
  }
}

function previewResearchBrief() {
  try {
    const brief = createBriefFromForm();
    renderPortableBrief(brief, "Preview only");
  } catch {
    return;
  }
}

function handleGuideChoice(event) {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.guidePurpose) choosePurpose(button);
  else if (button.dataset.guideDepth) chooseDepth(button);
  else if (button.dataset.guideMode) chooseResearchMode(button);
  else if (button.dataset.guidePreset) choosePreset(button);
}

function setupAccordions() {
  const container = document.querySelector("[data-accordion]");
  const items = [...container.querySelectorAll(".coverage-item")];
  const open = (selected) => {
    for (const item of items) {
      const active = item === selected;
      item.classList.toggle("active", active);
      const button = item.querySelector("button");
      const panel = item.querySelector('[role="region"]');
      button.setAttribute("aria-expanded", String(active));
      panel.hidden = !active;
    }
    if (window.matchMedia("(min-width: 861px)").matches) {
      container.style.gridTemplateColumns = items.map((item) => item === selected ? "1.55fr" : ".82fr").join(" ");
    } else {
      container.style.removeProperty("grid-template-columns");
    }
  };
  for (const item of items) item.querySelector("button").addEventListener("click", () => open(item));
  window.addEventListener("resize", () => {
    const active = items.find((item) => item.classList.contains("active")) || items[0];
    open(active);
  });
  open(items[0]);
}

function setupMotion() {
  if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    for (const item of document.querySelectorAll(".reveal")) item.classList.add("is-visible");
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -8%", threshold: 0.08 });
  for (const item of document.querySelectorAll(".reveal")) observer.observe(item);
}

ui.form.addEventListener("submit", submitResearch);
ui.previewBrief.addEventListener("click", previewResearchBrief);
ui.guideThread.addEventListener("click", handleGuideChoice);
ui.restartGuide.addEventListener("click", restartGuide);
ui.addGuideNote.addEventListener("click", addGuideDirection);
ui.guidedTab.addEventListener("click", () => setView("guided"));
ui.fieldsTab.addEventListener("click", () => setView("fields"));
ui.purpose.addEventListener("change", updateSummary);
ui.form.addEventListener("change", updateSummary);
window.addEventListener("scroll", () => ui.header.classList.toggle("scrolled", window.scrollY > 30), { passive: true });

updateSummary();
setupAccordions();
setupMotion();
probeEngine();
