export const meta = {
  name: "rn-audit",
  description:
    "React Native code auditor. Splits the target into review lenses, hunts suspect sites, pulls concrete defects from the code, then challenges each one to weed out false positives before ranking them into a fix-list.",
  whenToUse:
    'When the user wants a broad, low-noise audit of a React Native / Expo codebase or a diff. Pass the target as args: a path, a glob, or "diff" for the current branch against main. With no target it reviews the app source. For a fast look at a single file use /code-review instead — this one fans out many agents and is built for breadth.',
  phases: [
    { title: "Scope", detail: "Split the target into 5 RN review lenses" },
    {
      title: "Find",
      detail: "One agent per lens — grep/read to pin down suspect sites",
    },
    {
      title: "Inspect",
      detail: "Dedupe sites, read the top 20, pull provable defects",
    },
    {
      title: "Verify",
      detail: "3 challengers per finding — 2 knock-downs drop it",
    },
    {
      title: "Synthesize",
      detail: "Fold duplicates, sort by severity+confidence, attach fixes",
    },
  ],
};

// Pipeline shape: Scope → pipeline(Find → site-dedup → Inspect) → adversarial Verify → Synthesize.
// A generic "decompose → gather → challenge → merge" audit loop, specialized for RN and driven by
// Grep/Read/Bash over the repo. Every finding has to survive skeptical voters before it reaches the report.
// Target passed via Workflow({ name: 'rn-audit', args: '<path|glob|"diff">' }).

const VOTES_PER_FINDING = 3;
const REFUTATIONS_REQUIRED = 2;
const MAX_INSPECT = 10; // cap on suspect sites we read in full
const MAX_VERIFY = 12; // cap on findings we put up for challenge

// ─── Schemas ───
const SCOPE_SCHEMA = {
  type: "object",
  required: ["target", "lenses", "summary"],
  properties: {
    target: { type: "string" },
    summary: { type: "string" },
    lenses: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        required: ["label", "hint"],
        properties: {
          label: { type: "string" },
          hint: { type: "string" }, // what to grep for / where to look
          rationale: { type: "string" },
        },
      },
    },
  },
};
const FIND_SCHEMA = {
  type: "object",
  required: ["sites"],
  properties: {
    sites: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        required: ["file", "why", "suspicion"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          symbol: { type: "string" }, // component / hook / function name
          why: { type: "string" },
          suspicion: { enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};
const INSPECT_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["issue", "codeQuote", "severity"],
        properties: {
          issue: { type: "string" }, // a specific, checkable fault
          codeQuote: { type: "string" }, // the exact offending lines
          severity: { enum: ["blocker", "major", "minor", "nit"] },
          suggestedFix: { type: "string" },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence", "confidence"],
  properties: {
    refuted: { type: "boolean" },
    evidence: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
    falsePositiveReason: { type: "string" },
  },
};
const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "findings", "caveats"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: [
          "issue",
          "severity",
          "confidence",
          "locations",
          "suggestedFix",
        ],
        properties: {
          issue: { type: "string" },
          severity: { enum: ["blocker", "major", "minor", "nit"] },
          confidence: { enum: ["high", "medium", "low"] },
          locations: { type: "array", items: { type: "string" } }, // "file:line"
          evidence: { type: "string" },
          suggestedFix: { type: "string" },
          vote: { type: "string" },
        },
      },
    },
    caveats: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } },
  },
};

// ─── Phase 0: Scope — split the target into review lenses ───
phase("Scope");
const TARGET =
  (typeof args === "string" && args.trim()) ||
  "the React Native / Expo app source (src/, app/, or the project root)";
const scope = await agent(
  "Split this React Native audit target into a set of non-overlapping review lenses.\n\n" +
    "## Target\n" +
    TARGET +
    "\n\n" +
    "## Task\n" +
    'Get your bearings first: with Glob/Grep/Read (and `git diff --name-only main...` when the target is "diff") read enough to know the app\'s layout, its RN version, and whether the New Architecture is enabled. ' +
    "Then choose 5 review lenses that between them cover where THIS app is most likely to break. Fit the lenses to what the code actually shows. Draw from areas like:\n" +
    "- render cost (unstable props, absent memoization, closures built inside lists) · hook usage (captured stale values, dependency arrays that are wrong or missing, hooks behind conditionals) · long lists (FlatList/FlashList key handling, getItemLayout, expensive renderItem) · the native seam (bridge/JSI misuse, Turbo/Fabric readiness, platform-only gaps) · state and effects (setState churn, effects that never clean up, leaked subscriptions) · async and errors (rejected promises nobody catches, native calls with no guard) · accessibility · startup and bundle size\n" +
    "Give every lens a short label and a concrete `hint` naming what to grep for or where to look. Keep them distinct.\n" +
    "Return the target (as given or lightly tidied), a one-to-two sentence plan, and the lenses.\n\nReply through the schema only.",
  { label: "scope", schema: SCOPE_SCHEMA },
);
if (!scope) {
  return {
    error:
      "Scope agent returned no result — cannot split the audit target into lenses.",
  };
}
log("Target: " + TARGET.slice(0, 80));
log(
  "Lenses (" +
    scope.lenses.length +
    "): " +
    scope.lenses.map((l) => l.label).join(", "),
);

// ─── Site-dedup state — accumulates across finders as each one finishes ───
const normSite = (f, ln) =>
  String(f).replace(/^\.\//, "").toLowerCase() + (ln ? ":" + ln : "");
const seen = new Map();
const dupes = [];
const budgetDropped = [];
const suspRank = { high: 0, medium: 1, low: 2 };
let inspectSlots = MAX_INSPECT;

// ─── Prompts ───
const FIND_PROMPT = (lens) =>
  "## Reviewer — lens: " +
  lens.label +
  "\n\n" +
  "Audit target: " +
  TARGET +
  "\n\n" +
  "Lens: **" +
  lens.label +
  "** — " +
  (lens.rationale || "") +
  "\n" +
  "What to hunt: " +
  lens.hint +
  "\n\n" +
  "## Task\nWith Grep/Glob/Read, pin down the 4-6 places most likely to hold a real problem for this lens, staying inside the target. " +
  "Give the file, the line when you have it, and the component/hook/function name. " +
  "Add one sentence per site on what makes it suspect under THIS lens. Order them by how probably each is a genuine defect, not by how quickly you spotted it. " +
  "Ignore formatting and anything a linter would already catch; skip generated and vendor code.\n\nReply through the schema only.";

const INSPECT_PROMPT = (site, lens) =>
  "## Defect Extractor\n\n" +
  "Audit target: " +
  TARGET +
  "\n\n" +
  "Open this site and pull out concrete defects:\n" +
  "**File:** " +
  site.file +
  (site.line ? ":" + site.line : "") +
  (site.symbol ? "  (" + site.symbol + ")" : "") +
  "\n" +
  "**Raised by:** " +
  lens +
  " — " +
  site.why +
  "\n\n" +
  "## Task\n1. Read the file, plus any closely-tied file you need to judge it fairly.\n" +
  "2. Pull 2-5 defects that can be proven or disproven and that matter to the lens. Each one must:\n" +
  "   - name a specific, checkable fault (not a soft 'could read better')\n" +
  "   - quote the exact offending lines in `codeQuote`\n" +
  "   - carry a severity — blocker (crash, data loss, feature broken) · major (perf or correctness under normal use) · minor (edge case) · nit\n" +
  "   - come with a concrete `suggestedFix`\n" +
  "3. If a closer read clears the site, return an empty findings list. Never manufacture a defect to justify the read.\n\nReply through the schema only.";

const VERIFY_PROMPT = (finding, v) =>
  "## Challenger (voter " +
  (v + 1) +
  "/" +
  VOTES_PER_FINDING +
  ")\n\n" +
  "Your job is to knock this finding down, not to agree with it. If at least " +
  REFUTATIONS_REQUIRED +
  " of " +
  VOTES_PER_FINDING +
  " challengers knock it down, it is dropped.\n\n" +
  '## Finding under challenge\n"' +
  finding.issue +
  '"\n' +
  "**Location:** " +
  finding.file +
  (finding.line ? ":" + finding.line : "") +
  " · claimed severity: " +
  finding.severity +
  "\n" +
  "**Cited code:**\n" +
  finding.codeQuote +
  "\n\n" +
  "## Work through this against the real code before you vote.\n" +
  "1. Does the cited code actually show the fault, or is context missing that would make it correct?\n" +
  "2. Look around it — is the risk already handled elsewhere (a memo, a parent boundary, a cleanup, a guard)?\n" +
  "3. Is the severity larger than what really happens at runtime?\n" +
  "4. Is this a deliberate, idiomatic RN choice rather than a bug (an intentionally changing key, a known workaround)?\n" +
  "5. Does it fire under real usage, or only in theory?\n\n" +
  "Vote **refuted=true** when the finding is not a real fault, is already handled, is over-rated, is intentional, or is only theoretical.\n" +
  "Vote **refuted=false** only when the fault is real, reached at runtime, and roughly the severity claimed.\n" +
  "If you cannot tell, lean toward refuted=true.\n\nReply through the schema only, and ground your evidence in specific code.";

// ─── Pipeline: find → site-dedup → inspect+extract (no barrier) ───
const findResults = await pipeline(
  scope.lenses,

  (lens) =>
    agent(FIND_PROMPT(lens), {
      label: "find:" + lens.label,
      phase: "Find",
      schema: FIND_SCHEMA,
    }).then((r) => {
      if (!r) return null;
      log(lens.label + ": " + r.sites.length + " suspect sites");
      return { lens: lens.label, sites: r.sites };
    }),

  (findResult) => {
    const sorted = [...findResult.sites].sort(
      (a, b) => suspRank[a.suspicion] - suspRank[b.suspicion],
    );
    const novel = sorted.filter((s) => {
      const key = normSite(s.file, s.line);
      if (seen.has(key)) {
        dupes.push({ ...s, lens: findResult.lens, dupOf: seen.get(key) });
        return false;
      }
      if (inspectSlots <= 0 && suspRank[s.suspicion] >= 1) {
        budgetDropped.push({ ...s, lens: findResult.lens });
        return false;
      }
      seen.set(key, { lens: findResult.lens, symbol: s.symbol });
      inspectSlots--;
      return true;
    });
    if (novel.length < findResult.sites.length) {
      log(
        findResult.lens +
          ": " +
          novel.length +
          " novel (" +
          (findResult.sites.length - novel.length) +
          " filtered)",
      );
    }
    return parallel(
      novel.map(
        (site) => () =>
          agent(INSPECT_PROMPT(site, findResult.lens), {
            label: "inspect:" + String(site.file).split("/").pop(),
            phase: "Inspect",
            schema: INSPECT_SCHEMA,
          })
            .then((ext) => {
              // A skipped agent returns null — let it fall out via filter(Boolean) below, rather than
              // routing it through .catch() where it would masquerade as a real (but empty) inspection.
              if (!ext) return null;
              return {
                file: site.file,
                line: site.line,
                lens: findResult.lens,
                findings: ext.findings.map((f) => ({
                  ...f,
                  file: site.file,
                  line: site.line,
                })),
              };
            })
            .catch((e) => {
              log("inspect failed: " + site.file + " — " + (e.message || e));
              return {
                file: site.file,
                line: site.line,
                lens: findResult.lens,
                findings: [],
              };
            }),
      ),
    );
  },
);

const allSites = findResults.flat().filter(Boolean);
const allFindings = allSites.flatMap((s) => s.findings);
const sevRank = { blocker: 0, major: 1, minor: 2, nit: 3 };

const rankedFindings = [...allFindings]
  .sort((a, b) => sevRank[a.severity] - sevRank[b.severity])
  .slice(0, MAX_VERIFY);

log(
  "Inspected " +
    allSites.length +
    " sites → " +
    allFindings.length +
    " findings → challenging top " +
    rankedFindings.length,
);

if (rankedFindings.length === 0) {
  return {
    target: TARGET,
    summary:
      "No findings extracted. " +
      allSites.length +
      " sites inspected, all clean or empty. " +
      dupes.length +
      " site dupes, " +
      budgetDropped.length +
      " budget-dropped.",
    findings: [],
    refuted: [],
    stats: {
      lenses: scope.lenses.length,
      sites: allSites.length,
      findings: 0,
      dupes: dupes.length,
    },
  };
}

// ─── Verify: put each finding to a panel of challengers ───
// This barrier is deliberate: every finding has to be collected and ranked before any voting begins.
phase("Verify");
const voted = (
  await parallel(
    rankedFindings.map(
      (finding) => () =>
        parallel(
          Array.from(
            { length: VOTES_PER_FINDING },
            (_, v) => () =>
              agent(VERIFY_PROMPT(finding, v), {
                label: "v" + v + ":" + finding.issue.slice(0, 40),
                phase: "Verify",
                schema: VERDICT_SCHEMA,
              }),
          ),
        ).then((verdicts) => {
          // Null verdicts (a skip or an error) count as abstentions.
          const valid = verdicts.filter(Boolean);
          const refuted = valid.filter((v) => v.refuted).length;
          // A finding passes only if it was truly judged: enough real votes to form a quorum and
          // fewer than REFUTATIONS_REQUIRED against it. Mostly-abstained findings are unproven and
          // must stay out of the report — otherwise zero refutations would wave them straight through.
          const abstained = VOTES_PER_FINDING - valid.length;
          const survives =
            valid.length >= REFUTATIONS_REQUIRED &&
            refuted < REFUTATIONS_REQUIRED;
          log(
            '"' +
              finding.issue.slice(0, 50) +
              '…": ' +
              (valid.length - refuted) +
              "-" +
              refuted +
              (abstained > 0 ? " (" + abstained + " abstain)" : "") +
              " " +
              (survives ? "✓" : "✗"),
          );
          return {
            ...finding,
            verdicts: valid,
            refutedVotes: refuted,
            survives,
          };
        }),
    ),
  )
).filter(Boolean);

const confirmed = voted.filter((f) => f.survives);
const killed = voted.filter((f) => !f.survives);
log(
  "Verify done: " +
    voted.length +
    " findings → " +
    confirmed.length +
    " confirmed, " +
    killed.length +
    " killed (false positives)",
);

if (confirmed.length === 0) {
  return {
    target: TARGET,
    summary:
      "Every one of the " +
      voted.length +
      " findings was knocked down as a false positive. No confirmed defects.",
    findings: [],
    refuted: killed.map((f) => ({
      issue: f.issue,
      at: f.file + (f.line ? ":" + f.line : ""),
      vote: f.verdicts.length - f.refutedVotes + "-" + f.refutedVotes,
    })),
    stats: {
      lenses: scope.lenses.length,
      sites: allSites.length,
      findings: allFindings.length,
      verified: voted.length,
      confirmed: 0,
      killed: killed.length,
    },
  };
}

// ─── Synthesize ───
phase("Synthesize");
const confRank = { high: 0, medium: 1, low: 2 };
const block = confirmed
  .map((f, i) => {
    const best = f.verdicts
      .filter((v) => !v.refuted)
      .sort((a, b) => confRank[a.confidence] - confRank[b.confidence])[0];
    return (
      "### [" +
      i +
      "] (" +
      f.severity +
      ") " +
      f.issue +
      "\n" +
      "At: " +
      f.file +
      (f.line ? ":" + f.line : "") +
      " · Vote: " +
      (f.verdicts.length - f.refutedVotes) +
      "-" +
      f.refutedVotes +
      "\n" +
      "Code:\n" +
      f.codeQuote +
      "\n" +
      (f.suggestedFix ? "Proposed fix: " + f.suggestedFix + "\n" : "") +
      "Challenger evidence (" +
      (best ? best.confidence : "low") +
      "): " +
      (best ? best.evidence : "n/a") +
      "\n"
    );
  })
  .join("\n");

const killedBlock =
  killed.length > 0
    ? "\n## Knocked down (false positives, for transparency)\n" +
      killed
        .map(
          (f) =>
            '- "' +
            f.issue +
            '" (' +
            f.file +
            (f.line ? ":" + f.line : "") +
            ", vote " +
            (f.verdicts.length - f.refutedVotes) +
            "-" +
            f.refutedVotes +
            ")",
        )
        .join("\n")
    : "";

const report = await agent(
  "## Synthesis — RN audit report\n\n" +
    "**Target:** " +
    TARGET +
    "\n\n" +
    confirmed.length +
    " findings came through " +
    VOTES_PER_FINDING +
    "-vote challenge. Fold duplicates together and write them up.\n\n" +
    "## Surviving findings\n" +
    block +
    "\n" +
    killedBlock +
    "\n\n" +
    "## Instructions\n" +
    "1. Fold findings that point at the same fault into one, gathering their locations.\n" +
    "2. Keep each one actionable: the fault, where it lives, and a concrete fix.\n" +
    "3. Set confidence per finding: high (unanimous votes, code leaves no doubt), medium (a split vote or context-dependent), low (a single site or easy to misjudge).\n" +
    "4. Sort by severity (blocker first), then by confidence.\n" +
    "5. Open with a 3-5 sentence summary: how healthy the code looks and the first thing to fix.\n" +
    "6. Record caveats: what you could not verify statically, what needs a running app or a profiler.\n" +
    "7. Add 2-4 follow-up questions worth a later pass.\n\nReply through the schema only.",
  { label: "synthesize", schema: REPORT_SCHEMA },
);

if (!report) {
  // Synthesis was skipped or failed — hand back the confirmed findings unmerged instead of
  // dereferencing report.findings and throwing away the whole run.
  return {
    target: TARGET,
    summary:
      "Synthesis step was skipped or failed — returning " +
      confirmed.length +
      " confirmed findings unmerged.",
    findings: [],
    confirmed: confirmed.map((f) => ({
      issue: f.issue,
      severity: f.severity,
      at: f.file + (f.line ? ":" + f.line : ""),
      fix: f.suggestedFix,
      vote: f.verdicts.length - f.refutedVotes + "-" + f.refutedVotes,
    })),
    refuted: killed.map((f) => ({
      issue: f.issue,
      at: f.file + (f.line ? ":" + f.line : ""),
      vote: f.verdicts.length - f.refutedVotes + "-" + f.refutedVotes,
    })),
    stats: {
      lenses: scope.lenses.length,
      sites: allSites.length,
      findings: allFindings.length,
      verified: voted.length,
      confirmed: confirmed.length,
      killed: killed.length,
      afterSynthesis: 0,
    },
  };
}

return {
  target: TARGET,
  ...report,
  refuted: killed.map((f) => ({
    issue: f.issue,
    at: f.file + (f.line ? ":" + f.line : ""),
    vote: f.verdicts.length - f.refutedVotes + "-" + f.refutedVotes,
  })),
  stats: {
    lenses: scope.lenses.length,
    sitesInspected: allSites.length,
    findingsExtracted: allFindings.length,
    findingsVerified: voted.length,
    confirmed: confirmed.length,
    killed: killed.length,
    afterSynthesis: report.findings.length,
    siteDupes: dupes.length,
    budgetDropped: budgetDropped.length,
    agentCalls:
      1 +
      scope.lenses.length +
      allSites.length +
      voted.length * VOTES_PER_FINDING +
      1,
  },
};
