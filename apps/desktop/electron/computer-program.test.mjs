import assert from "node:assert/strict";
import test from "node:test";
import { runComputerProgram } from "@openwork/computer-use/runtime";
import { createComputerControl, COMPUTER_PROTOCOL } from "@openwork/computer-use/computer-control";

function browserFixture() {
  let value = "";
  let checked = false;
  let saves = 0;
  let observationId = 0;
  const calls = [];
  const host = {
    computer: async () => { throw new Error("Wrong surface"); },
    browser: async (operation, args, _signal) => {
      calls.push(operation);
      if (operation === "open") return { ok: true, tabId: "owned" };
      if (operation === "observe") return { ok: true, observationId: String(++observationId), viewport: { width: 800, height: 600 }, text: saves ? "Saved 1" : "Ready", elements: [
        { ref: "title", role: "textbox", name: "Title", value, bounds: { x: 10, y: 10, width: 300, height: 30 } },
        { ref: "details", role: "checkbox", name: "Details", checked, bounds: { x: 10, y: 50, width: 100, height: 30 } },
        { ref: "save", role: "button", name: "Save", bounds: { x: 10, y: 90, width: 100, height: 30 } },
        ...(saves ? [{ ref: "saved", role: "text", name: "Saved 1", bounds: { x: 10, y: 130, width: 100, height: 30 } }] : []),
      ], ...(args.includeImage ? { image: { mimeType: "image/png", data: "fixture-pixels" } } : {}) };
      if (operation === "act") {
        assert.equal(args.observationId, String(observationId));
        observationId++;
        const action = args.action;
        if (action.type === "fill") value = action.text;
        if (action.type === "click" && action.ref === "details") checked = !checked;
        if (action.type === "set_checked" && action.ref === "details") checked = action.checked;
        if (action.type === "click" && action.ref === "save") saves++;
        return { ok: true, dispatched: true };
      }
      throw new Error("Unknown fixture operation");
    },
  };
  return { host, calls, state: () => ({ value, checked, saves }) };
}

test("a conditional program fills, checks idempotently and saves once", async () => {
  const f = browserFixture();
  const result = await runComputerProgram({ surface: "browser", code: `
    await tools.ui.fill({target:{role:"textbox",name:"Title"},text:"Weekly report"});
    await tools.ui.setChecked({target:{name:"Details"},checked:true});
    await tools.ui.setChecked({target:{name:"Details"},checked:true});
    if(await tools.ui.exists({target:{name:"Save"}})) await tools.ui.click({target:{name:"Save"}});
    await tools.ui.waitFor({target:{text:"Saved 1"}});
    return {saved:true};
  ` }, f.host, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { saved: true });
  assert.deepEqual(f.state(), { value: "Weekly report", checked: true, saves: 1 });
  assert.equal(result.metrics.actions, 3);
});

test("images are attached outside program JSON and failed input is never replayed", async () => {
  let inputs = 0;
  const f = browserFixture();
  const result = await runComputerProgram({ surface: "browser", code: 'await tools.ui.observe({screenshot:true}); await tools.ui.click({target:{name:"Save"}}); return true;' }, {
    ...f.host,
    browser: async (operation, args, signal) => {
      if (operation === "act") { inputs++; return { ok: false, code: "disconnected", error: "Receipt unavailable", mayHaveChangedState: true }; }
      return f.host.browser(operation, args, signal);
    },
  }, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "disconnected");
  assert.equal(inputs, 1);
  assert.deepEqual(result.images, []);
  assert.equal(result.mayHaveActed, true);
  assert.deepEqual(result.receipts, [{ index: 0, status: "unconfirmed" }]);
});

test("a semantic target is observed again after a confirmed refusal before input", async () => {
  const f = browserFixture();
  let attempts = 0;
  const observed = [];
  const result = await runComputerProgram({ surface: "browser", code: 'await tools.ui.click({target:{name:"Save"}}); return true;' }, {
    ...f.host,
    browser: async (operation, args, signal) => {
      if (operation === "act") {
        attempts++; observed.push(args.observationId);
        if (attempts === 1) return { ok: false, code: "stale_observation", dispatched: false, mayHaveChangedState: false };
      }
      return f.host.browser(operation, args, signal);
    },
  }, new AbortController().signal);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(attempts, 2);
  assert.equal(new Set(observed).size, 2);
  assert.equal(f.state().saves, 1);
  assert.deepEqual(result.receipts.map(receipt => receipt.status), ["failed", "dispatched"]);
});

test("target refresh is bounded and never repeats uncertain or dispatched input", async () => {
  for (const response of [
    { code: "stale_observation", dispatched: false, mayHaveChangedState: false, expectedAttempts: 3 },
    { code: "stale_observation", dispatched: true, mayHaveChangedState: true, expectedAttempts: 1 },
    { code: "stale_observation", dispatched: false, expectedAttempts: 1 },
    { code: "disconnected", dispatched: false, mayHaveChangedState: false, expectedAttempts: 1 },
  ]) {
    const f = browserFixture();
    let attempts = 0;
    const result = await runComputerProgram({ surface: "browser", code: 'await tools.ui.click({target:{name:"Save"}}); return true;' }, {
      ...f.host,
      browser: async (operation, args, signal) => {
        if (operation === "act") { attempts++; return { ok: false, ...response }; }
        return f.host.browser(operation, args, signal);
      },
    }, new AbortController().signal);
    assert.equal(result.ok, false);
    assert.equal(attempts, response.expectedAttempts, JSON.stringify(response));
    assert.equal(f.state().saves, 0);
  }
});

test("native partial receipts survive a failed program without replay", async () => {
  let inputs = 0;
  const text = value => ({content:[{type:"text",text:JSON.stringify(value)}]});
  const result = await runComputerProgram({surface:"computer",code:'await tools.ui.act({action:{type:"key",key:"enter"}}); return true;'}, {
    browser: async () => { throw new Error("Wrong surface"); },
    computer: async name => {
      if(name === "computer_observe") return text({ok:true,observation_id:"fresh",width:800,height:600,elements:[]});
      inputs++;
      return text({ok:true,status:"partial",completed:0,failed:0,skipped:0,may_have_acted:true,message:"Input interrupted"});
    },
  }, new AbortController().signal);
  assert.equal(result.ok,false);
  assert.equal(inputs,1);
  assert.deepEqual(result.receipts,[{index:0,status:"partial",completed:0,failed:0,skipped:0}]);
});

const nativeText = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
// Synthetic native BatchProgress receipt; desktop changes alone do not imply input.
const nativeStale = (action = "press") => ({
  ok: false, status: "failed", code: "stale_observation", next: "observe",
  completed: 0, failed_step: 0, may_have_acted: false,
  steps: [{ action, index: 0, status: "skipped", code: "stale_observation" }],
  desktop: { front_app_changed: true },
});
function computerFixture({ respond = () => nativeText({ ok: true, status: "dispatched", completed: 1 }), elements, observe } = {}) {
  const calls = [], inputs = [];
  let observations = 0;
  const host = {
    browser: async () => { throw new Error("Wrong surface"); },
    computer: async (name, args, signal) => {
      calls.push({ name, args });
      if (name === "computer_observe") {
        observations++;
        const view = { ok: true, mode: "control", observation_id: `view-${observations}`, width: 800, height: 600, ...(args.include_image ? {image:{included:true,width:800,height:600}} : {}), elements: elements?.(observations) ?? [
          { ref: `save-${observations}`, role: "AXButton", name: "Save", actions: ["press"], bounds: { x: 10, y: 20, width: 100, height: 30 } },
          { ref: `title-${observations}`, role: "AXTextField", name: "Title", settable: true, actions: ["press"], bounds: { x: 10, y: 70, width: 200, height: 30 } },
        ] };
        return observe ? observe(view, args) : { content: [...nativeText(view).content, ...(args.include_image ? [{type:"image",data:"synthetic",mimeType:"image/png"}] : [])] };
      }
      assert.equal(name, "computer_act");
      assert.equal(args.observation_id, `view-${observations}`);
      inputs.push(args.action);
      return respond(args.action, inputs.length, signal);
    },
  };
  return { host, calls, inputs, run: (code, signal = new AbortController().signal) => runComputerProgram({ surface: "computer", code }, host, signal) };
}

test("native atomic semantic actions re-observe text and reselect changed refs", async () => {
  for (const [type, code, prefix] of [
    ["press", 'await tools.ui.click({target:{role:"button",name:"Save"}}); return true;', "save"],
    ["set_value", 'await tools.ui.fill({target:{role:"textbox",text:"Title",exact:true},text:"Report"}); return true;', "title"],
  ]) {
    const f = computerFixture({
      respond: (_, attempt) => nativeText(attempt === 1 ? nativeStale(type) : { ok: true, status: "dispatched", completed: 1 }),
      observe: (view, args) => args.include_image ? nativeText({ ok: false, code: "privacy_incomplete" }) : nativeText(view),
    });
    const result = await f.run(code);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.inputs.map(action => [action.type, action.ref]), [[type, `${prefix}-1`], [type, `${prefix}-2`]]);
    assert.deepEqual(result.receipts.map(receipt => receipt.status), ["failed", "dispatched"]);
    assert.equal(result.metrics.observations, 2);
    assert.equal(result.mayHaveActed, true);
    assert.deepEqual(result.images, []);
  }
});

test("native stale recovery exhausts after two refreshes", async () => {
  const f = computerFixture({ respond: () => nativeText(nativeStale()) });
  const result = await f.run('await tools.ui.click({target:{role:"button",name:"Save"}});');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "stale_observation");
  assert.deepEqual(f.inputs.map(action => action.ref), ["save-1", "save-2", "save-3"]);
  assert.equal(result.metrics.observations, 3);
  assert.equal(result.mayHaveActed, true);
});

test("native setChecked never replays a toggle after state changes during stale refusal", async () => {
  let checked = false;
  const f = computerFixture({
    elements: () => [{ref:"check",role:"checkbox",name:"Enable option",press:true,checked}],
    respond: action => { checked = true; return nativeText(nativeStale(action.type)); },
  });
  const result = await f.run('await tools.ui.setChecked({target:{role:"checkbox",name:"Enable option"},checked:true});');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "stale_observation");
  assert.equal(f.inputs.length, 1);
  assert.equal(checked, true);
});

test("native recovery requires the entire strict no-input receipt", async () => {
  const malformed = [
    { ok: true }, { status: undefined }, { status: "partial" }, { status: "dispatched" },
    { completed: undefined }, { completed: "0" }, { completed: 1 },
    { failed_step: undefined }, { failed_step: 1 }, { may_have_acted: undefined }, { may_have_acted: true },
    { code: "person_interacting" }, { next: "human_takeover" }, { next: undefined }, { dispatched: true },
    { steps: undefined }, { steps: [] }, { steps: [{}] },
    { steps: [{ ...nativeStale().steps[0], index: 1 }] },
    { steps: [{ ...nativeStale().steps[0], action: "set_value" }] },
    { steps: [{ ...nativeStale().steps[0], status: "uncertain" }] },
    { steps: [{ ...nativeStale().steps[0], status: "dispatched" }] },
    { steps: [{ ...nativeStale().steps[0], code: "person_interacting" }] },
    { steps: [{ ...nativeStale().steps[0], path: "accessibility" }] },
    { steps: [{ ...nativeStale().steps[0], may_have_acted: true }] },
    { steps: [...nativeStale().steps, { action: "press", index: 1, status: "dispatched" }] },
    { steps: [...nativeStale().steps, { action: "press", index: 1, status: "skipped" }] },
    { failed_phase: "after_dispatch" }, { post_observation: { ok: false, code: "privacy_incomplete" } },
  ];
  for (const patch of malformed) {
    const f = computerFixture({ respond: () => nativeText({ ...nativeStale(), ...patch }) });
    const result = await f.run('await tools.ui.click({target:{role:"button",name:"Save"}});');
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(f.inputs.length, 1, JSON.stringify(patch));
    assert.equal(result.mayHaveActed, true);
  }
  for (const response of [
    {}, { content: [{ type: "text", text: "unreadable receipt" }] },
    { content: [...nativeText(nativeStale()).content, ...nativeText({ ok: true, status: "dispatched" }).content] },
    { content: [...nativeText(nativeStale()).content, { type: "text", text: "unreadable extra receipt" }] },
  ]) {
    const f = computerFixture({ respond: () => response });
    const result = await f.run('await tools.ui.click({target:{role:"button",name:"Save"}});');
    assert.equal(f.inputs.length, 1);
    assert.equal(result.mayHaveActed, true);
  }
});

test("native recovery excludes weak selectors, nth, raw refs, keys, typing, coordinates and scroll", async () => {
  for (const code of [
    'await tools.ui.click({target:{name:"Save"}});',
    'await tools.ui.click({target:{role:"button"}});',
    'await tools.ui.click({target:{role:"button",name:"Save",nth:0}});',
    'await tools.ui.click({target:{role:"button",name:"Save",exact:false}});',
    'await tools.ui.fill({target:{role:"textbox",name:"Title",nth:0},text:"Report"});',
    'await tools.ui.act({action:{type:"press",ref:"save-1"}});',
    'await tools.ui.act({action:{type:"set_value",ref:"title-1",text:"Report"}});',
    'await tools.ui.key({key:"enter"});',
    'await tools.ui.act({action:{type:"type",text:"Report"}});',
    'await tools.ui.act({action:{type:"click",x:20,y:30}});',
    'await tools.ui.scroll({direction:"down"});',
  ]) {
    const f = computerFixture({ respond: action => nativeText(nativeStale(action.type)) });
    const result = await f.run(code);
    assert.equal(result.ok, false, code);
    assert.equal(f.inputs.length, 1, code);
  }
});

test("native coordinate fallback never retries or switches back to semantic input", async () => {
  const f = computerFixture({
    elements: generation => [{ ref: `save-${generation}`, role: "button", name: "Save", bounds: { x: 10, y: 10, width: 100, height: 30 } }],
    respond: () => nativeText(nativeStale("click")),
  });
  assert.equal((await f.run('await tools.ui.click({target:{role:"button",name:"Save"}});')).ok, false);
  assert.deepEqual(f.inputs, [{ type: "click", x: 60, y: 25 }]);
});

test("Button role without press never silently clicks in assist mode", async () => {
  const f = computerFixture({
    elements: () => [{ref:"tab",role:"Button",name:"Example tab",x:20,y:30,w:100,h:25}],
    observe: view => nativeText({...view,mode:"assist"}),
  });
  const result = await f.run('await tools.ui.click({target:{role:"Button",name:"Example tab"}});');
  assert.equal(result.error.code, "control_mode_required");
  assert.equal(result.metrics.actions, 0);
  assert.equal(result.mayHaveActed, false);
  assert.equal(f.inputs.length, 0);
  assert.equal(f.calls.length, 1);
});

test("coordinate fallback and scroll require an actual usable screenshot", async () => {
  for (const code of ['await tools.ui.click({target:{role:"Button",name:"Example tab"}});', 'await tools.ui.scroll({direction:"down"});']) {
    for (const [image, expected] of [
      [{included:false,unavailable:{code:"privacy_incomplete"}}, "privacy_incomplete"],
      [{included:true,width:800,height:600}, "image_required"],
    ]) {
      const f = computerFixture({
        elements: () => [{ref:"tab",role:"Button",name:"Example tab",x:20,y:30,w:100,h:25}],
        observe: view => nativeText({...view, image}),
      });
      const result = await f.run(code);
      assert.equal(result.error.code, expected);
      assert.equal(result.mayHaveActed, false);
      assert.equal(f.inputs.length, 0);
    }
  }
});

test("assist mode still permits genuine semantic press without a screenshot", async () => {
  const f = computerFixture({observe: view => nativeText({...view,mode:"assist",image:{included:false,unavailable:{code:"privacy_incomplete"}}})});
  assert.equal((await f.run('await tools.ui.click({target:{role:"button",name:"Save"}});')).ok, true);
  assert.equal(f.inputs[0].type, "press");
});

test("native reselect fails closed for missing, ambiguous, disabled or changed capabilities", async () => {
  for (const change of [() => [], node => [node, { ...node, ref: "other" }], node => [{ ...node, disabled: true }], node => [{ ...node, press: false }]]) {
    const f = computerFixture({
      elements: generation => {
        const node = { ref: `save-${generation}`, role: "button", name: "Save", press: true };
        return generation === 1 ? [node] : change(node);
      },
      respond: () => nativeText(nativeStale()),
    });
    assert.equal((await f.run('await tools.ui.click({target:{role:"button",name:"Save"}});')).ok, false);
    assert.equal(f.inputs.length, 1);
  }
});

test("native multi-action fills never replay earlier input", async () => {
  for (const [append, failedType, expected] of [[false, "key", ["press", "key"]], [false, "type", ["press", "key", "type"]], [true, "type", ["press", "type"]]]) {
    const f = computerFixture({
      elements: generation => [{ ref: `title-${generation}`, role: "textbox", name: "Title", press: true }],
      respond: action => nativeText(action.type === failedType ? nativeStale(action.type) : { ok: true, status: "dispatched" }),
    });
    assert.equal((await f.run(`await tools.ui.fill({target:{role:"textbox",name:"Title"},text:"Report",append:${append}});`)).ok, false);
    assert.deepEqual(f.inputs.map(action => action.type), expected);
  }
});

test("native fillForm recovery retries only the refused atomic field", async () => {
  const f = computerFixture({ respond: (_, attempt) => nativeText(attempt === 2 ? nativeStale("set_value") : { ok: true, status: "dispatched" }) });
  const result = await f.run('await tools.ui.fillForm({fields:[{target:{role:"textbox",name:"Title"},text:"First"},{target:{role:"textbox",name:"Title"},text:"Second"}]});');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.inputs.map(action => action.text), ["First", "Second", "Second"]);
  assert.deepEqual(f.inputs.map(action => action.ref), ["title-1", "title-2", "title-3"]);
});

test("native transport uncertainty, failed post-observation and failed refresh never replay", async () => {
  for (const respond of [
    () => { throw new Error("Receipt lost"); },
    () => nativeText({ ok: true, status: "dispatched", post_observation: { ok: false, code: "privacy_incomplete" } }),
    () => nativeText({ ...nativeStale(), status: "partial", completed: 1, may_have_acted: true }),
  ]) {
    const f = computerFixture({ respond });
    const result = await f.run('await tools.ui.click({target:{role:"button",name:"Save"}});');
    assert.equal(result.ok, false);
    assert.equal(result.mayHaveActed, true);
    assert.equal(f.inputs.length, 1);
  }
  const f = computerFixture({ respond: () => nativeText(nativeStale()), observe: view => nativeText(view.observation_id === "view-1" ? view : { ok: false, code: "privacy_incomplete" }) });
  const result = await f.run('await tools.ui.click({target:{role:"button",name:"Save"}});');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "privacy_incomplete");
  assert.equal(f.inputs.length, 1);
});

test("a recovered native action with a broker post-observation failure is not repeated", async () => {
  const f = computerFixture({ respond: (_, attempt) => attempt === 1 ? nativeText(nativeStale()) : {
    content: [
      ...nativeText({ ok: true, status: "dispatched", completed: 1 }).content,
      ...nativeText({ post_observation: { ok: false, code: "privacy_incomplete" }, actions_replayed: false, next: "observe" }).content,
    ],
  } });
  const result = await f.run('await tools.ui.click({target:{role:"button",name:"Save"}});');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "post_observation_failed");
  assert.equal(result.mayHaveActed, true);
  assert.equal(f.inputs.length, 2);
  assert.deepEqual(result.receipts.map(receipt => receipt.status), ["failed", "dispatched"]);
});

test("Stop during native stale recovery prevents all further dispatch", async () => {
  for (const duringBackoff of [false, true]) {
    const controller = new AbortController();
    const f = computerFixture({ respond: () => {
      if (duringBackoff) setTimeout(() => controller.abort(), 10);
      else controller.abort();
      return nativeText(nativeStale());
    } });
    const result = await f.run('await tools.ui.click({target:{role:"button",name:"Save"}});', controller.signal);
    assert.equal(result.ok, false);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.calls.length, 2);
    assert.equal(result.mayHaveActed, true);
  }
});

function nativeFixture() {
  const text = (value) => ({ type: "text", text: JSON.stringify(value) });
  const actions = [];
  let id = 0;
  let findOpen = false;
  const view = () => ({ ok: true, observation_id: `o${++id}`, image: { width: 600, height: 500 },
    focused_ref: findOpen ? "e3" : "e1",
    elements: [
      { ref: "e1", role: "TextArea", x: 0, y: findOpen ? 130 : 100, w: 586, h: findOpen ? 350 : 380, settable: true },
      { ref: "e2", role: "StaticText", value: "\u200E408", x: 160, y: 60, w: 60, h: 30 },
      ...(findOpen ? [{ ref: "e3", role: "TextField", x: 10, y: 104, w: 300, h: 22, settable: true }, { ref: "e4", role: "Button", label: "Done", press: true, x: 500, y: 104, w: 60, h: 22 }] : []),
    ] });
  const host = {
    browser: async () => { throw new Error("Wrong surface"); },
    computer: async (name, args) => {
      if (name === "computer_observe") return { content: [text(view())] };
      if (name !== "computer_act") throw new Error(`Unexpected ${name}`);
      actions.push(args.action);
      if (args.action.type === "key" && args.action.key === "f") findOpen = true;
      return { content: [text({ ok: true, status: "dispatched", completed: 1 }), text(view())] };
    },
  };
  return { host, actions };
}

test("findText fills the unnamed field that takes focus after Command-F", async () => {
  const f = nativeFixture();
  const result = await runComputerProgram({ surface: "computer", code: 'return await tools.ui.findText({text:"lazy"});' }, f.host, new AbortController().signal);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.value, { searched: true });
  assert.deepEqual(f.actions, [
    { type: "key", key: "f", modifiers: ["command"] },
    { type: "set_value", ref: "e3", text: "lazy" },
    { type: "key", key: "enter" },
  ]);
});

test("a menu-bar path runs as one native menu command without waiting", async () => {
  const f = nativeFixture();
  const started = Date.now();
  const result = await runComputerProgram({ surface: "computer", code: 'return await tools.ui.menu({path:["Format","Font","Bold"]});' }, f.host, new AbortController().signal);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.value, { activated: "Bold" });
  assert.deepEqual(f.actions, [{ type: "menu", path: ["Format", "Font", "Bold"] }]);
  assert.ok(Date.now() - started < 1000, "the menu bar is not waited out");
});

test("a single title outside the window fails at once with a code the program can read", async () => {
  const f = nativeFixture();
  const result = await runComputerProgram({ surface: "computer", code: `
    try { await tools.ui.menu({path:["Format"]}); return "ran"; }
    catch (error) { return error.message; }
  ` }, f.host, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.ok(typeof result.value === "string");
  assert.match(result.value, /^menu_not_in_window: "Format" is not a control in the selected window/);
  assert.deepEqual(f.actions, []);
});

test("invisible direction marks are dropped from names and values", async () => {
  const f = nativeFixture();
  const result = await runComputerProgram({ surface: "computer", code: 'const view = await tools.ui.observe({}); return view.elements.find((e) => e.role === "text").value;' }, f.host, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.equal(result.value, "408");
});

test("code has no ambient filesystem, process or network access", async () => {
  for (const code of ['return process.env;', 'return require("node:fs");', 'return await fetch("https://example.com");']) {
    const f = browserFixture();
    const result = await runComputerProgram({ surface: "browser", code }, f.host, new AbortController().signal);
    assert.equal(result.ok, false);
    assert.deepEqual(f.calls, []);
  }
});

test("an offscreen control is hidden to waits and revealed before clicking", async () => {
  const f = browserFixture();
  const dispatched = [];
  let revealed = false;
  const host = { ...f.host, browser: async (operation, args, signal) => {
    const result = await f.host.browser(operation, args, signal);
    if (operation === "observe" && "elements" in result) result.elements = result.elements.map(element => ({ ...element, visible: element.ref !== "save" || revealed }));
    if (operation === "act") { dispatched.push(args.action.type); if (args.action.type === "reveal") revealed = true; }
    return result;
  } };
  const result = await runComputerProgram({ surface: "browser", code: `
    await tools.ui.waitFor({target:{name:"Save"},state:"hidden"});
    await tools.ui.click({target:{name:"Save"}});
    await tools.ui.waitFor({target:{name:"Save"},state:"visible"});
    return true;
  ` }, host, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.deepEqual(dispatched, ["reveal", "click"]);
  assert.equal(f.state().saves, 1);
});

test("a failed navigation receipt is marked uncertain and is never repeated", async () => {
  const f = browserFixture();
  let opens = 0;
  const result = await runComputerProgram({ surface: "browser", code: 'await tools.ui.open({url:"https://example.com"}); return true;' }, {
    ...f.host, browser: async () => { opens++; throw new Error("Navigation receipt lost"); },
  }, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.equal(result.mayHaveActed, true);
  assert.equal(opens, 1);
});

test("the broker gates programs and cancels old waits across off/on", async (t) => {
  const f = browserFixture();
  const control = createComputerControl({
    adapters: [{ id: "local", label: "Local", placement: "local", protocol: COMPUTER_PROTOCOL, readiness: async () => ({ readiness: "ready", detail: "Ready" }), connect: async () => { throw new Error("Browser programs never open a native helper"); } }],
    runProgram: runComputerProgram,
    browserTask: ({ operation, args }, { signal }) => f.host.browser(operation, args, signal),
  });
  t.after(() => control.reset(true));
  /** @type {import("@openwork/computer-use/runtime").ProgramRequest & { sessionId: string }} */
  const input = { sessionId: "chat", surface: "browser", code: 'return await tools.ui.waitFor({target:{name:"Not here"},timeoutMs:5000});' };
  assert.equal((await control.program(input)).ok, false);
  assert.deepEqual(f.calls, []);
  await control.setFeatureEnabled(true);
  const running = control.program(input);
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await control.program(input)).error.code, "program_busy");
  await control.setFeatureEnabled(false);
  await control.setFeatureEnabled(true);
  const stopped = await running;
  assert.equal(stopped.ok, false);
  const count = f.calls.length;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.calls.length, count);
});
