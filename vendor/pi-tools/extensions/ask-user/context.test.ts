import { strict as assert } from "node:assert";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import askUser, {
  buildAskUserContextSections,
  renderAskUserLayout,
} from "./index.ts";
import { ASK_USER_PROMPT_GUIDELINES } from "./prompt.ts";
import {
  ASK_USER_TIMEOUT_MS,
  createTuiDeadline,
  deadlineDelay,
  isClearlyLocalReversibleOption,
  parseTimeoutVerdict,
  runTimeoutVerifier,
  verifiedLocalSelection,
} from "./safety.ts";

test("timeout safety validators fail closed", () => {
  assert.equal(ASK_USER_TIMEOUT_MS, 600_000);
  assert.equal(deadlineDelay(10, 5), 0);
  assert.equal(deadlineDelay(10, 15), 5);
  assert.equal(isClearlyLocalReversibleOption("Run workspace tests"), true);
  assert.equal(isClearlyLocalReversibleOption("Push PR"), false);
  assert.deepEqual(
    parseTimeoutVerdict(
      '{"verdict":"select","index":0,"audit":"local test"}',
      1,
    ),
    { verdict: "select", index: 0, audit: "local test" },
  );
  assert.equal(
    parseTimeoutVerdict('{"verdict":"select","index":2,"audit":"bad"}', 1),
    undefined,
  );
  assert.equal(
    parseTimeoutVerdict(
      '{"verdict":"select","index":0,"audit":"x","extra":true}',
      1,
    ),
    undefined,
  );
  assert.equal(parseTimeoutVerdict("not json", 1), undefined);
  const safe = {
    question: "Which local check?",
    options: [{ label: "Run tests", description: "Read-only verification" }],
  };
  assert.deepEqual(
    verifiedLocalSelection('{"verdict":"select","index":0,"audit":"ok"}', safe),
    { verdict: "select", index: 0, audit: "ok" },
  );
  assert.equal(
    parseTimeoutVerdict(
      '{"verdict":"decline","index":0,"audit":"bad keys"}',
      1,
    ),
    undefined,
  );
  for (const unsafe of [
    "Push",
    "PR",
    "deploy",
    "email",
    "Jira",
    "commit",
    "merge",
    "release",
    "publish",
    "delete",
    "drop",
    "reset",
    "token",
    "password",
    "purchase",
  ])
    assert.equal(
      verifiedLocalSelection('{"verdict":"select","index":0,"audit":"no"}', {
        ...safe,
        options: [{ label: `Run tests then ${unsafe}` }],
      }),
      undefined,
    );
  assert.equal(
    verifiedLocalSelection('{"verdict":"select","index":0,"audit":"no"}', {
      ...safe,
      context: "Deploy after test",
    }),
    undefined,
  );
  for (const field of [
    "approvalScope",
    "considerations",
    "recommendation",
    "explanation",
  ] as const)
    assert.equal(
      verifiedLocalSelection('{"verdict":"select","index":0,"audit":"no"}', {
        ...safe,
        [field]:
          field === "considerations"
            ? ["email owner"]
            : field === "explanation"
              ? { label: "deploy" }
              : "delete workspace",
      }),
      undefined,
    );
  assert.equal(
    verifiedLocalSelection('{"verdict":"select","index":0,"audit":"no"}', {
      ...safe,
      multiSelect: true,
    }),
    undefined,
  );
});

test("deadline aborts only TUI signal and cleanup clears timer", () => {
  let callback: (() => void) | undefined;
  let cleared = false;
  const parent = new AbortController();
  const deadline = createTuiDeadline(600_000, parent.signal, {
    setTimeout: ((fn: () => void) => {
      callback = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: (() => {
      cleared = true;
    }) as typeof clearTimeout,
  });
  callback?.();
  assert.equal(deadline.signal.aborted, true);
  assert.equal(parent.signal.aborted, false);
  assert.equal(deadline.timedOut(), true);
  deadline.cleanup();
  assert.equal(cleared, true);
});

test("production timeout verifier runs once, maps zero-based selections, and defers unsafe results", async () => {
  const params = {
    question: "Which local check?",
    options: [
      { label: "Run workspace tests" },
      { label: "Inspect workspace diff" },
    ],
  };
  let calls = 0;
  const selected = await runTimeoutVerifier(params, {
    run: async () => {
      calls++;
      return {
        status: "done",
        output: '{"verdict":"select","index":1,"audit":"local"}',
      };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(selected, {
    kind: "selected",
    verdict: { verdict: "select", index: 1, audit: "local" },
  });

  for (const completion of [
    { status: "done" as const, output: "bad" },
    {
      status: "done" as const,
      output: '{"verdict":"select","index":0,"audit":"local"}',
    },
    { status: "error" as const, output: "", error: "x".repeat(600) },
  ]) {
    const outcome = await runTimeoutVerifier(
      completion.status === "done" && completion.output.startsWith("{")
        ? { ...params, context: "deploy later" }
        : params,
      { run: async () => completion },
    );
    assert.equal(outcome.kind, "defer");
    if (outcome.kind === "defer")
      assert.ok(outcome.verdict.audit.length <= 500);
  }
  assert.equal((await runTimeoutVerifier(params, undefined)).kind, "defer");
});

test("production timeout verifier cancels spawned service and cannot select after parent abort", async () => {
  const parent = new AbortController();
  let release!: () => void;
  let cancelled: readonly string[] | undefined;
  const outcome = runTimeoutVerifier(
    {
      question: "Which local check?",
      options: [{ label: "Run workspace tests" }],
    },
    {
      run: async (onSpawn) => {
        onSpawn("verifier-1");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          status: "done",
          output: '{"verdict":"select","index":0,"audit":"local"}',
        };
      },
      cancel: async (ids) => {
        cancelled = ids;
      },
    },
    parent.signal,
  );
  parent.abort();
  release();
  assert.deepEqual(await outcome, { kind: "aborted" });
  assert.deepEqual(cancelled, ["verifier-1"]);
});

test("contextual decisions expose evidence, recommendation, and approval scope", () => {
  assert.deepEqual(
    buildAskUserContextSections({
      context:
        "Thread requested fail-fast startup behavior; current configuration now throws.",
      considerations: [
        "No further code change is needed.",
        "Replying and resolving the thread mutates GitHub state.",
      ],
      recommendation: "Handle as addressed after one final verification.",
      approvalScope:
        "Approve verification only; reply and resolution need separate approval.",
    }),
    [
      {
        label: "Context",
        text: "Thread requested fail-fast startup behavior; current configuration now throws.",
      },
      {
        label: "Considerations",
        text: "• No further code change is needed.\n• Replying and resolving the thread mutates GitHub state.",
      },
      {
        label: "Recommendation",
        text: "Handle as addressed after one final verification.",
      },
      {
        label: "Approval scope",
        text: "Approve verification only; reply and resolution need separate approval.",
      },
    ],
  );
});

test("rich approvals render as visually separated decision cards", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const lines = renderAskUserLayout({
    width: 60,
    theme: theme as never,
    optionIndex: 0,
    editMode: false,
    params: {
      context: "Current code already uses asynchronous disposal.",
      considerations: [
        "No code change is needed.",
        "Replying mutates GitHub state.",
      ],
      recommendation: "Approve the exact reply and resolve this thread.",
      approvalScope: "This thread only; no other comments or code changes.",
      question: "Approve reply and resolve?",
      options: [
        {
          label: "Approve reply + resolve",
          description: "Post exact text and verify the resolved state.",
        },
        { label: "Edit response", description: "Post nothing yet." },
      ],
    },
    allOptions: [
      {
        label: "Approve reply + resolve",
        description: "Post exact text and verify the resolved state.",
      },
      { label: "Edit response", description: "Post nothing yet." },
      { label: "Write my own answer…", isOther: true },
    ],
  });
  const text = lines.join("\n");
  assert.match(text, /^╭─ Decision required /);
  assert.match(text, /│ ● CONTEXT/);
  assert.match(text, /│ ◆ CONSIDERATIONS/);
  assert.match(text, /│ ✓ RECOMMENDATION/);
  assert.match(text, /│ ⚠ APPROVAL SCOPE/);
  assert.match(text, /├─ DECISION /);
  assert.match(text, /│ ❯ 1\. Approve reply \+ resolve/);
  assert.match(text, /│     Post exact text and verify the resolved state\./);
  assert.match(text, /╰─+╯$/);
  assert.ok(lines.every((line) => visibleWidth(line) === 60));
});

test("simple questions stay compact and width-safe", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const lines = renderAskUserLayout({
    width: 44,
    theme: theme as never,
    optionIndex: 1,
    editMode: false,
    params: {
      question: "Choose environment?",
      options: [{ label: "Local" }, { label: "Staging" }],
    },
    allOptions: [
      { label: "Local" },
      { label: "Staging" },
      { label: "Write my own answer…", isOther: true },
    ],
  });
  const text = lines.join("\n");
  assert.match(text, /^╭─ Question /);
  assert.doesNotMatch(text, /CONTEXT|DECISION/);
  assert.match(text, /│ ❯ 2\. Staging/);
  assert.ok(lines.every((line) => visibleWidth(line) === 44));
});

test("long content wraps safely and tiny widths use a borderless fallback", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const longLabel =
    "Approve this deliberately long option label without losing any decision text";
  const longToken = "x".repeat(120);
  const common = {
    theme: theme as never,
    optionIndex: 0,
    editMode: false,
    params: {
      context: "Context",
      question: "q".repeat(200_000),
      options: [{ label: longLabel, description: longToken }, { label: "No" }],
    },
    allOptions: [
      { label: longLabel, description: longToken },
      { label: "No" },
      { label: "Write my own answer…", isOther: true },
    ],
  };
  const normal = renderAskUserLayout({ ...common, width: 40 });
  const normalText = normal.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.match(normalText, /e expand/);
  assert.match(normalText, /…/);
  assert.ok(normal.every((line) => visibleWidth(line) === 40));

  const expanded = renderAskUserLayout({
    ...common,
    width: 40,
    expanded: true,
    viewportHeight: 200,
  });
  const expandedContent = expanded
    .join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[│\n]/g, " ");
  assert.ok(expandedContent.replace(/\s+/g, " ").includes(longLabel));
  assert.ok(expandedContent.replace(/\s+/g, "").includes(longToken));

  for (const width of [1, 5, 12, 20]) {
    const narrow = renderAskUserLayout({ ...common, width });
    assert.ok(narrow.length <= 64);
    assert.ok(narrow.every((line) => visibleWidth(line) <= width));
    assert.doesNotMatch(narrow.join("\n"), /[╭╮╰╯]/);
    if (width === 5) {
      const text = narrow.join("\n");
      assert.match(text, /Appro/);
      assert.match(text, /No/);
      assert.match(text, /Write/);
    }
  }

  const minimumFramed = renderAskUserLayout({ ...common, width: 24 });
  assert.ok(minimumFramed.length < 200);
  assert.match(minimumFramed.join("\n"), /Approve/);
  assert.match(minimumFramed.join("\n"), /2\. No/);
});

test("fenced code renders as an indented block with complete expandable details", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const context = `Command potom použije:

\`\`\`csharp
new UpsertTenantFromImportCommand
{
    SourceId = sourceId,
    RegistrationNumber = registrationNumberValue,
    Name = name,
    CooperationStart = cooperationStart,
    CooperationEnd = ParseDate(source.CooperationEnd),
}
\`\`\``;
  const common = {
    width: 80,
    theme: theme as never,
    optionIndex: 0,
    editMode: false,
    params: {
      context,
      question: "Approve?",
      options: [{ label: "Yes" }, { label: "No" }],
    },
    allOptions: [
      { label: "Yes" },
      { label: "No" },
      { label: "Write my own answer…", isOther: true },
    ],
  };

  const compact = renderAskUserLayout(common);
  const compactText = compact.join("\n");
  assert.doesNotMatch(compactText, /```/);
  assert.match(compactText, /┌─ csharp/);
  assert.match(compactText, /e expand/);
  assert.match(compactText, /…/);

  const expanded = renderAskUserLayout({
    ...common,
    expanded: true,
    viewportHeight: 100,
  });
  const expandedText = expanded.join("\n");
  assert.doesNotMatch(expandedText, /```/);
  assert.match(expandedText, /┌─ csharp/);
  assert.match(
    expandedText,
    /CooperationEnd = ParseDate\(source\.CooperationEnd\),/,
  );
  assert.match(expandedText, /└─/);
  assert.match(
    expanded.find((line) => line.includes("SourceId")) ?? "",
    / {4}SourceId/,
  );
  assert.ok(expanded.every((line) => visibleWidth(line) === 80));
});

test("selected option renders its Markdown proposal and follows navigation", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const common = {
    width: 72,
    theme: theme as never,
    editMode: false,
    params: {
      question: "Choose implementation?",
      options: [
        {
          label: "Local guard",
          description: "Validate at each private boundary.",
          details: "**Proposal**\n\n```csharp\nUseAlpha();\n```",
        },
        {
          label: "Shared extractor",
          description: "Centralize validation.",
          details: "**Proposal**\n\n```csharp\nUseBeta();\n```",
        },
      ],
    },
    allOptions: [
      {
        label: "Local guard",
        description: "Validate at each private boundary.",
        details: "**Proposal**\n\n```csharp\nUseAlpha();\n```",
      },
      {
        label: "Shared extractor",
        description: "Centralize validation.",
        details: "**Proposal**\n\n```csharp\nUseBeta();\n```",
      },
      { label: "Write my own answer…", isOther: true },
    ],
  };

  const first = renderAskUserLayout({ ...common, optionIndex: 0 }).join("\n");
  assert.match(first, /SELECTED OPTION/);
  assert.match(first, /UseAlpha\(\);/);
  assert.doesNotMatch(first, /UseBeta\(\);|```/);

  const second = renderAskUserLayout({ ...common, optionIndex: 1 }).join("\n");
  assert.match(second, /SELECTED OPTION/);
  assert.match(second, /UseBeta\(\);/);
  assert.doesNotMatch(second, /UseAlpha\(\);|```/);
  assert.ok(
    renderAskUserLayout({ ...common, optionIndex: 1 }).every(
      (line) => visibleWidth(line) === 72,
    ),
  );

  const expanded = renderAskUserLayout({
    ...common,
    optionIndex: 1,
    expanded: true,
    viewportHeight: 100,
  }).join("\n");
  assert.match(expanded, /UseAlpha\(\);/);
  assert.match(expanded, /UseBeta\(\);/);

  const tableDetails = [
    "| Možnosť | Výsledok |",
    "|---|---|",
    "| Prvá | Rozhodnutie |",
    "| Druhá | Bez rozhodnutia |",
    "| Tretia | Dismissal |",
  ].join("\n");
  const tablePreview = renderAskUserLayout({
    ...common,
    params: {
      question: "Choose implementation?",
      options: [{ label: "Comparison", details: tableDetails }],
    },
    allOptions: [{ label: "Comparison", details: tableDetails }],
    optionIndex: 0,
  }).join("\n");
  assert.match(tablePreview, /Tretia/);
  assert.doesNotMatch(tablePreview, /│ …/);
  assert.match(tablePreview, /e details/);
});

test("arrow navigation updates selected proposal before confirmation", async () => {
  let tool: any;
  askUser({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as never);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const renders: string[] = [];
  const result = await tool.execute(
    "call",
    {
      question: "Choose implementation?",
      options: [
        { label: "Alpha", details: "Alpha proposal marker" },
        { label: "Beta", details: "Beta proposal marker" },
      ],
    },
    undefined,
    undefined,
    {
      mode: "tui",
      ui: {
        custom(factory: Function) {
          return new Promise((resolve) => {
            const component = factory(
              {
                requestRender() {},
                terminal: { rows: 30, columns: 80 },
              },
              theme,
              {},
              resolve,
            );
            renders.push(component.render(72).join("\n"));
            component.handleInput("\x1b[B");
            renders.push(component.render(72).join("\n"));
            component.handleInput("\r");
          });
        },
      },
    },
  );

  assert.match(renders[0], /Alpha proposal marker/);
  assert.doesNotMatch(renders[0], /Beta proposal marker/);
  assert.match(renders[1], /Beta proposal marker/);
  assert.doesNotMatch(renders[1], /Alpha proposal marker/);
  assert.equal(result.details.answer, "Beta");
  assert.equal(result.details.index, 2);
});

test("multi-select toggles compatible options and returns ordered arrays", async () => {
  let tool: any;
  askUser({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as never);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const renders: string[] = [];
  const result = await tool.execute(
    "call",
    {
      multiSelect: true,
      question: "Which checks should run?",
      options: [
        { label: "Unit tests" },
        { label: "TypeScript" },
        { label: "Formatting" },
      ],
    },
    undefined,
    undefined,
    {
      mode: "tui",
      ui: {
        custom(factory: Function) {
          return new Promise((resolve) => {
            const component = factory(
              {
                requestRender() {},
                terminal: { rows: 30, columns: 80 },
              },
              theme,
              {},
              resolve,
            );
            renders.push(component.render(72).join("\n"));
            component.handleInput("2");
            component.handleInput("\x1b[A");
            component.handleInput(" ");
            renders.push(component.render(72).join("\n"));
            component.handleInput("\r");
          });
        },
      },
    },
  );

  assert.match(renders[0], /\[ \] Unit tests/);
  assert.match(renders[0], /Enter confirm/);
  assert.match(renders[1], /\[x\] Unit tests/);
  assert.match(renders[1], /\[x\] TypeScript/);
  assert.equal(result.details.multiSelect, true);
  assert.equal(result.details.answer, null);
  assert.deepEqual(result.details.answers, ["Unit tests", "TypeScript"]);
  assert.deepEqual(result.details.indices, [1, 2]);
  assert.equal(result.details.cancelled, false);
  assert.equal(
    result.content[0].text,
    "User selected options 1, 2: Unit tests, TypeScript",
  );
});

test("multi-select requires one checked decision before Enter confirms", async () => {
  let tool: any;
  askUser({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as never);
  let doneCalls = 0;
  const result = await tool.execute(
    "call",
    {
      multiSelect: true,
      question: "Which checks should run?",
      options: [{ label: "Unit tests" }, { label: "TypeScript" }],
    },
    undefined,
    undefined,
    {
      mode: "tui",
      ui: {
        custom(factory: Function) {
          return new Promise((resolve) => {
            const component = factory(
              {
                requestRender() {},
                terminal: { rows: 30, columns: 80 },
              },
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              {},
              (value: unknown) => {
                doneCalls++;
                resolve(value);
              },
            );
            component.handleInput("\r");
            assert.equal(doneCalls, 0);
            component.handleInput(" ");
            component.handleInput("\r");
          });
        },
      },
    },
  );

  assert.equal(doneCalls, 1);
  assert.deepEqual(result.details.answers, ["Unit tests"]);
  assert.deepEqual(result.details.indices, [1]);
});

test("multi-select keeps the custom-answer action separate", async () => {
  let tool: any;
  askUser({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as never);
  const result = await tool.execute(
    "call",
    {
      multiSelect: true,
      question: "Which checks should run?",
      options: [{ label: "Unit tests" }, { label: "TypeScript" }],
    },
    undefined,
    undefined,
    {
      mode: "tui",
      ui: {
        custom(factory: Function) {
          return new Promise((resolve) => {
            const component = factory(
              {
                requestRender() {},
                terminal: { rows: 30, columns: 80 },
              },
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              {},
              resolve,
            );
            component.handleInput("4");
            component.handleInput("Only the smoke suite");
            component.handleInput("\r");
          });
        },
      },
    },
  );

  assert.equal(result.details.multiSelect, true);
  assert.equal(result.details.answer, "Only the smoke suite");
  assert.equal(result.details.answers, undefined);
  assert.equal(result.details.indices, undefined);
  assert.equal(result.details.wasCustom, true);
  assert.equal(result.details.cancelled, false);
});

test("localized deeper explanation is not an answer or approval", async () => {
  let tool: any;
  askUser({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as never);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const renders: string[] = [];
  const result = await tool.execute(
    "call",
    {
      question: "Ktorý návrh schvaľuješ?",
      options: [{ label: "Prvý" }, { label: "Druhý" }],
      explanation: {
        label: "Potrebujem lepšie vysvetlenie…",
        description: "Doplň dôvody, flow, kód alebo alternatívy.",
        question: "Čo potrebuješ vysvetliť podrobnejšie?",
        answerLabel: "Napísať vlastnú odpoveď…",
        rationale: {
          label: "Vysvetliť dôvody a riziká",
          description: "Prečo je zmena potrebná.",
        },
        flow: {
          label: "Ukázať flow krok po kroku",
          description: "Ako bude správanie prebiehať.",
        },
        code: {
          label: "Ukázať konkrétny kód alebo diff",
          description: "Predložiť implementačný návrh.",
          details: '```csharp\nconst string Marker = "SLOVAK_CODE_MODE";\n```',
        },
        alternatives: {
          label: "Porovnať alternatívy",
          description: "Kedy sa hodí každá možnosť.",
        },
        custom: {
          label: "Položiť vlastnú otázku",
          description: "Napísať, čo zostalo nejasné.",
        },
      },
    },
    undefined,
    undefined,
    {
      mode: "tui",
      ui: {
        custom(factory: Function) {
          return new Promise((resolve) => {
            const component = factory(
              {
                requestRender() {},
                terminal: { rows: 32, columns: 90 },
              },
              theme,
              {},
              resolve,
            );
            renders.push(component.render(84).join("\n"));
            component.handleInput("3");
            renders.push(component.render(84).join("\n"));
            component.handleInput("\x1b");
            renders.push(component.render(84).join("\n"));
            component.handleInput("3");
            component.handleInput(" ");
            component.handleInput("\x1b[B");
            component.handleInput("\x1b[B");
            component.handleInput(" ");
            renders.push(component.render(84).join("\n"));
            component.handleInput("\r");
          });
        },
      },
    },
  );

  assert.match(renders[0], /\? Potrebujem lepšie vysvetlenie/);
  assert.match(renders[0], /Napísať vlastnú odpoveď/);
  assert.match(renders[1], /Čo potrebuješ vysvetliť podrobnejšie/);
  assert.match(renders[1], /\[ \] Vysvetliť dôvody a riziká/);
  assert.match(renders[1], /Space or 1-5 toggle/);
  assert.match(renders[2], /Ktorý návrh schvaľuješ/);
  assert.match(renders[3], /\[x\] Vysvetliť dôvody a riziká/);
  assert.match(renders[3], /\[x\] Ukázať konkrétny kód alebo diff/);
  assert.match(renders[3], /SLOVAK_CODE_MODE/);
  assert.equal(result.details.answer, null);
  assert.equal(result.details.cancelled, false);
  assert.equal(result.details.explanationRequested, true);
  assert.equal(result.details.explanationMode, "rationale");
  assert.deepEqual(result.details.explanationModes, ["rationale", "code"]);
  assert.match(result.content[0].text, /not an answer, approval, dismissal/);
  assert.match(result.content[0].text, /language the user is using/);
  assert.match(result.content[0].text, /call ask_user again/);
});

test("Enter preserves single-mode explanation when nothing is toggled", async () => {
  let tool: any;
  askUser({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as never);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const result = await tool.execute(
    "call",
    {
      question: "Choose?",
      options: [{ label: "One" }, { label: "Two" }],
    },
    undefined,
    undefined,
    {
      mode: "tui",
      ui: {
        custom(factory: Function) {
          return new Promise((resolve) => {
            const component = factory(
              {
                requestRender() {},
                terminal: { rows: 30, columns: 80 },
              },
              theme,
              {},
              resolve,
            );
            component.handleInput("3");
            component.handleInput("\x1b[B");
            component.handleInput("\x1b[B");
            component.handleInput("\r");
          });
        },
      },
    },
  );

  assert.deepEqual(result.details.explanationModes, ["code"]);
  assert.equal(result.details.explanationMode, "code");
});

test("custom explanation captures clarification without selecting a decision", async () => {
  let tool: any;
  askUser({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as never);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const result = await tool.execute(
    "call",
    {
      question: "Choose?",
      options: [{ label: "One" }, { label: "Two" }],
    },
    undefined,
    undefined,
    {
      mode: "tui",
      ui: {
        custom(factory: Function) {
          return new Promise((resolve) => {
            const component = factory(
              {
                requestRender() {},
                terminal: { rows: 30, columns: 80 },
              },
              theme,
              {},
              resolve,
            );
            component.handleInput("3");
            component.handleInput(" ");
            component.handleInput("5");
            component.handleInput("Why is this safer?");
            component.handleInput("\r");
          });
        },
      },
    },
  );

  assert.equal(result.details.answer, null);
  assert.equal(result.details.cancelled, false);
  assert.equal(result.details.explanationMode, "rationale");
  assert.deepEqual(result.details.explanationModes, ["rationale", "custom"]);
  assert.equal(result.details.explanationRequest, "Why is this safer?");
  assert.match(result.content[0].text, /Why is this safer\?/);
});

test("interactive details preserve decision keys and scroll within terminal height", async () => {
  let tool: any;
  askUser({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as never);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const renders: string[][] = [];
  const terminal = { rows: 16, columns: 80 };
  const result = await tool.execute(
    "call",
    {
      context: `Context\n\n\`\`\`csharp\n${Array.from({ length: 20 }, (_, index) => `    Line${index}();`).join("\n")}\n\`\`\``,
      question: "Approve?",
      options: [{ label: "Yes" }, { label: "No" }],
    },
    undefined,
    undefined,
    {
      mode: "tui",
      ui: {
        custom(factory: Function) {
          return new Promise((resolve) => {
            const component = factory(
              { requestRender() {}, terminal },
              theme,
              {},
              resolve,
            );
            renders.push(component.render(80));
            component.handleInput("e");
            renders.push(component.render(80));
            component.handleInput("\r");
            component.handleInput("\x1b[6~");
            renders.push(component.render(80));
            component.handleInput("\x1b");
            renders.push(component.render(80));
            component.handleInput("\x1b[B");
            component.handleInput("\r");
          });
        },
      },
    },
  );

  assert.match(renders[0].join("\n"), /e expand/);
  assert.match(renders[1].join("\n"), /Decision details/);
  assert.match(renders[1].join("\n"), /1-/);
  assert.notEqual(renders[1].join("\n"), renders[2].join("\n"));
  assert.match(renders[3].join("\n"), /Decision required/);
  assert.ok(renders[1].length <= terminal.rows);
  assert.ok(renders[2].length <= terminal.rows);
  assert.equal(result.details.answer, "No");
});

test("interactive component recomputes on resize and clamps editor width", async () => {
  let tool: any;
  askUser({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as never);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const rendered: Array<{ width: number; lines: string[] }> = [];
  const result = await tool.execute(
    "call",
    {
      question: "Choose environment?",
      options: [{ label: "Local" }, { label: "Staging" }],
    },
    undefined,
    undefined,
    {
      mode: "tui",
      ui: {
        custom(factory: Function) {
          return new Promise((resolve) => {
            const component = factory(
              {
                requestRender() {},
                terminal: { rows: 24, columns: 80 },
              },
              theme,
              {},
              resolve,
            );
            rendered.push({ width: 60, lines: component.render(60) });
            rendered.push({ width: 30, lines: component.render(30) });
            component.handleInput("4");
            rendered.push({ width: 3, lines: component.render(3) });
            resolve(null);
          });
        },
      },
    },
  );
  assert.equal(result.details.cancelled, true);
  for (const render of rendered) {
    assert.ok(render.lines.every((line) => visibleWidth(line) <= render.width));
  }
  assert.equal(visibleWidth(rendered[0].lines[0]), 60);
  assert.equal(visibleWidth(rendered[1].lines[0]), 30);
});

test("abort cancels ask_user and removes both abort listeners", async () => {
  let tool: any;
  askUser({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as never);
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const signal = controller.signal as AbortSignal & {
    addEventListener: typeof controller.signal.addEventListener;
    removeEventListener: typeof controller.signal.removeEventListener;
  };
  const addEventListener = signal.addEventListener.bind(signal) as (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  const removeEventListener = signal.removeEventListener.bind(signal) as (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) => void;
  signal.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "abort") added++;
    addEventListener(type, listener, options);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === "abort") removed++;
    removeEventListener(type, listener, options);
  }) as typeof signal.removeEventListener;

  let doneCalls = 0;
  const result = await tool.execute(
    "call",
    { question: "Choose?", options: [{ label: "One" }, { label: "Two" }] },
    signal,
    undefined,
    {
      mode: "tui",
      ui: {
        custom(factory: Function) {
          return new Promise((resolve) => {
            const component = factory(
              { requestRender() {}, terminal: { rows: 24, columns: 80 } },
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              {},
              (value: unknown) => {
                doneCalls++;
                resolve(value);
              },
            );
            controller.abort();
            component.handleInput("1");
          });
        },
      },
    },
  );

  assert.equal(result.content[0].text, "Cancelled");
  assert.equal(result.details.cancelled, true);
  assert.equal(doneCalls, 1);
  assert.equal(added, removed);
});

test("ask_user keeps simple questions backward compatible and guides rich approvals", () => {
  let registered:
    { parameters?: { properties?: Record<string, unknown> } } | undefined;
  askUser({
    registerTool(tool: unknown) {
      registered = tool as typeof registered;
    },
  } as never);
  const properties = registered?.parameters?.properties;
  assert.ok(properties?.question);
  assert.ok(properties?.options);
  assert.ok(properties?.multiSelect);
  assert.ok(properties?.explanation);
  assert.ok(properties?.context);
  assert.ok(properties?.considerations);
  assert.ok(properties?.recommendation);
  assert.ok(properties?.approvalScope);
  assert.equal(
    (properties?.question as { maxLength?: number }).maxLength,
    1_000,
  );
  assert.equal(
    (properties?.context as { maxLength?: number }).maxLength,
    2_000,
  );
  const optionProperties = (
    properties?.options as {
      items?: { properties?: Record<string, { maxLength?: number }> };
    }
  ).items?.properties;
  assert.equal(optionProperties?.details?.maxLength, 3_000);
  const explanationProperties = (
    properties?.explanation as {
      properties?: Record<string, { maxLength?: number }>;
    }
  ).properties;
  assert.equal(explanationProperties?.label?.maxLength, 160);
  assert.equal(explanationProperties?.answerLabel?.maxLength, 160);
  assert.ok(explanationProperties?.code);
  assert.deepEqual(buildAskUserContextSections({}), []);
  assert.ok(
    ASK_USER_PROMPT_GUIDELINES.some((line) => line.includes("approvalScope")),
  );
  assert.ok(
    ASK_USER_PROMPT_GUIDELINES.some(
      (line) =>
        line.includes("multiSelect") && line.includes("chosen together"),
    ),
  );
  assert.ok(
    ASK_USER_PROMPT_GUIDELINES.some((line) =>
      line.includes("option's details field"),
    ),
  );
  assert.ok(
    ASK_USER_PROMPT_GUIDELINES.some(
      (line) =>
        line.includes("language the user is currently using") &&
        line.includes("never be treated as an answer"),
    ),
  );
});
