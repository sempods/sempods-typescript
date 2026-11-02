/* global document, getComputedStyle, history, innerHeight, innerWidth, location, MutationObserver, window */
// The checks of the UI gate (scripts/test-ui-consumer.mjs), ported from the
// template's spike #120 (gate.mjs, roundtrip.mjs, interaction.mjs,
// evidence.mjs, contrast-selftest.mjs and routing-gate.mjs on
// sempods-apps-template branch claude/120-ui-spike). Each suite takes
// { browser, origin, engine } and returns results of the form
// { id, pass, ... }.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const contrastScript = readFileSync(
  join(import.meta.dirname, 'ui-contrast.js'),
  'utf8',
);
const EDIT = ' (edited)';
const xsd = 'http://www.w3.org/2001/XMLSchema#';
const startDate = 'https://schema.org/startDate';
const PLUMBER = 'Call the plumber about the kitchen tap';
const PERSONAL = 'Call the plumber (personal copy)';
const TRAIN = 'Book train tickets to Leipzig';

/** The plumber task of the fixture Pod: its IRI, address and two Contexts. */
function plumberTask(origin) {
  const iri = origin + '/alice/tasks/1';
  const id = Buffer.from(iri, 'utf8').toString('base64url');
  return {
    iri,
    id,
    at: `/tasks/${id}`,
    work: origin + '/alice/_system/contexts/work',
    personal: origin + '/alice/_system/contexts/personal',
  };
}

/** The page's address: path and query. */
function addressOf(page) {
  const url = new URL(page.url());
  return url.pathname + url.search;
}

/**
 * The key that moves the focus to the next control. WebKit on macOS follows
 * Safari's default and skips buttons on Tab; Option+Tab reaches them.
 */
const tabKey = (engine) =>
  engine === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';

async function newPage(browser, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-GB',
    ...options,
  });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

/** The Context chooser of the SDK's sign-in. */
const chooser = (page) => page.getByLabel(/Data context|Datenkontext/);

/**
 * Signs in to the fixture Pod on `address` and chooses its "work" context,
 * unless `choose` is false.
 */
async function signIn(page, origin, address = '/', { choose = true } = {}) {
  await fetch(origin + '/__reset');
  await page.goto(origin + address);
  await page.getByLabel(/Pod address|Pod-Adresse/).fill(origin + '/alice');
  await page.getByRole('button', { name: /^(Sign in|Anmelden)$/ }).click();
  if (!choose) return;
  await chooser(page).selectOption({ label: 'work' });
  await loaded(page);
}

/**
 * Waits until the page shows the Pod's tasks, so its connection and Context
 * catalogue reads are done. WebKit reports a read that a navigation cancels
 * as a page error.
 */
function loaded(page) {
  return page
    .locator('.zen-title, .gate-list a')
    .first()
    .waitFor({ timeout: 15000 });
}

/** Types the edit at the end of the task's title, as a person does. */
async function typeEdit(page, title) {
  await title.click();
  await title.press('End');
  await page.keyboard.type(EDIT);
}

/** Whether the task's title still ends with the edit. */
async function editKept(title) {
  return (await title.inputValue({ timeout: 2000 }).catch(() => '')).endsWith(
    EDIT,
  );
}

/** Answers the SDK's leave question, if it asks: keep editing, or discard. */
async function answerLeave(page, choice) {
  const confirm = page.getByRole('alertdialog');
  const asked = await shown(confirm, 3000);
  if (asked) {
    const buttons = confirm.getByRole('button');
    await (choice === 'keep' ? buttons.first() : buttons.last()).click();
    await hidden(confirm);
    await settle(page);
  }
  return asked;
}

/** Runs one check; an exception is a failure with its first line as note. */
async function attempt(id, run, extra = {}) {
  try {
    return { id, ...extra, ...(await run()) };
  } catch (error) {
    return {
      id,
      ...extra,
      pass: false,
      note: 'error: ' + error.message.split('\n')[0],
    };
  }
}

/**
 * Runs one check on a shared page; the page errors that arrive while it runs
 * name it. One that a check leaves pending can arrive under the next one.
 */
async function attemptOn(errors, id, run) {
  const from = errors.length;
  const result = await attempt(id, run);
  for (let i = from; i < errors.length; i++) errors[i] = `${id}: ${errors[i]}`;
  return result;
}

/**
 * Waits until no finite animation or transition runs (at most 5s), then for
 * React to commit. Headless WebKit on Linux runs them far slower than their
 * durations, so a fixed pause can catch a closing menu or a focus outline
 * halfway; the end state is what the checks assert.
 */
async function settle(page) {
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (a) =>
              a.playState !== 'running' ||
              a.effect?.getTiming().iterations === Infinity,
          ),
      undefined,
      { timeout: 5000, polling: 50 },
    )
    .catch(() => {});
  await page.waitForTimeout(50);
}

/**
 * Waits until the task dialog just opened shows its fields and has been open
 * for 600ms. React Aria's useDialog focuses a dialog that has lost the focus
 * again 500ms after it opened, for VoiceOver (react-aria
 * `dialog/useDialog.mjs`); a menu or date chooser closed before then hands its
 * focus to the dialog instead of to its button. People take longer than that,
 * a script does not.
 */
async function dialogReady(page) {
  const opened = Date.now();
  await page
    .getByRole('dialog', { name: 'Details' })
    .getByRole('textbox')
    .first()
    .waitFor();
  await settle(page);
  await page.waitForTimeout(Math.max(0, 600 - (Date.now() - opened)));
}

/** Opens the first task of the Zen view by pointer. */
async function openTask(page) {
  await page.locator('.zen-title').click();
  await dialogReady(page);
}

/** Whether the element reaches the state within the time (default 10s). */
const reaches =
  (state) =>
  (locator, timeout = 10000) =>
    locator
      .first()
      .waitFor({ state, timeout })
      .then(
        () => true,
        () => false,
      );
const hidden = reaches('hidden');
const shown = reaches('visible');
const gone = reaches('detached');
/** Polls the focus description until it matches (at most 5s). */
async function focusUntil(page, pattern, describe = focusInfo) {
  let focus = await describe(page);
  for (let end = Date.now() + 5000; !pattern.test(focus) && Date.now() < end;) {
    await page.waitForTimeout(50);
    focus = await describe(page);
  }
  return focus;
}

/** The focused element and the layer it sits in. */
const focusInfo = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    const name =
      el.getAttribute('aria-label') ||
      el.textContent?.trim().slice(0, 24) ||
      '';
    const layer = el.closest('[role=alertdialog]')
      ? 'sdk-confirm'
      : el.closest('[role=dialog]')
        ? 'dialog'
        : 'page';
    return `${el.tagName.toLowerCase()}${name ? `"${name}"` : ''}@${layer}`;
  });

const gateChecks = {
  // Escape in a dirty field asks first; the dialog and the draft stay.
  'escape-field-dirty': async (c, page) => {
    await c.open();
    await c.dirty();
    await page.keyboard.press('Escape');
    await shown(c.confirm, 3000);
    const s = await c.state();
    return { pass: s.dialogOpen && s.confirmOpen && s.draftKept, ...s };
  },
  // Escape in the SDK confirmation closes only the confirmation.
  'escape-in-sdk-confirm': async (c, page) => {
    await c.open();
    await c.dirty();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await c.confirm.waitFor({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await hidden(c.confirm);
    await focusUntil(page, /@dialog$/);
    const s = await c.state();
    return {
      pass:
        s.dialogOpen &&
        !s.confirmOpen &&
        s.draftKept &&
        s.focus.endsWith('@dialog'),
      ...s,
    };
  },
  // Escape with focus on the heading's Close asks through the guard.
  'escape-on-close-button': async (c, page) => {
    await c.open();
    await c.dirty();
    await page.getByRole('button', { name: 'Close', exact: true }).focus();
    await page.keyboard.press('Escape');
    await shown(c.confirm, 3000);
    const asked = await c.state();
    if (asked.confirmOpen) {
      await page.keyboard.press('Escape');
      await hidden(c.confirm);
    }
    const s = await c.state();
    return {
      pass: asked.confirmOpen && s.dialogOpen && s.draftKept && !s.confirmOpen,
      asked: asked.confirmOpen,
      ...s,
    };
  },
  // Close by pointer, Cancel in the SDK question: everything stays; the
  // question is on top, centred and keeps Tab.
  'close-click-cancel': async (c, page) => {
    await c.open();
    await c.dirty();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await c.confirm.waitFor({ timeout: 3000 });
    const top = await c.confirm.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return !!hit && el.contains(hit);
    });
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press(c.tab);
      await page.waitForTimeout(50);
    }
    const trapped = (await focusInfo(page)).endsWith('@sdk-confirm');
    const centred = await c.confirm.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return Math.abs(r.left + r.width / 2 - innerWidth / 2) < 4;
    });
    await c.confirm.getByRole('button').first().click();
    await hidden(c.confirm);
    const s = await c.state();
    return {
      pass:
        top &&
        trapped &&
        centred &&
        s.dialogOpen &&
        s.draftKept &&
        !s.confirmOpen,
      confirmOnTop: top,
      confirmCentred: centred,
      tabTrappedInConfirm: trapped,
      ...s,
    };
  },
  // Escape in the heading's menu closes only the menu.
  'escape-heading-menu': async (c, page) => {
    await c.open();
    await c.dirty();
    await page.getByRole('button', { name: 'Task menu' }).click();
    await page.getByRole('menu').waitFor();
    // Opened completely, as a person sees it, before Escape.
    await settle(page);
    await page.keyboard.press('Escape');
    const menuOpen = !(await hidden(page.getByRole('menu')));
    await focusUntil(page, /Task menu/);
    const s = await c.state();
    return {
      pass:
        !menuOpen && s.dialogOpen && s.draftKept && /Task menu/.test(s.focus),
      menuOpen,
      ...s,
    };
  },
  // Escape in the date chooser inside the editor fields closes only it.
  'escape-date-chooser': async (c, page) => {
    await c.open();
    await c.dirty();
    await page.getByRole('button', { name: /^Start considering:/ }).click();
    await page.getByRole('grid').waitFor();
    await settle(page);
    await page.keyboard.press('Escape');
    const gridOpen = !(await hidden(page.getByRole('grid')));
    await focusUntil(page, /Start considering/);
    const s = await c.state();
    return {
      pass:
        !gridOpen &&
        s.dialogOpen &&
        s.draftKept &&
        !s.confirmOpen &&
        /Start considering/.test(s.focus),
      gridOpen,
      ...s,
    };
  },
  // Escape in the SDK delete question closes only that question.
  'escape-delete-confirm': async (c, page) => {
    await c.open();
    await c.dirty();
    await c.dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    const asked = await shown(c.confirm, 3000);
    if (asked) {
      await page.keyboard.press('Escape');
      await hidden(c.confirm);
    }
    const s = await c.state();
    return { pass: asked && s.dialogOpen && !s.confirmOpen, asked, ...s };
  },
  // Tab stays in the dialog; the page behind is inert or hidden.
  'focus-trapped-in-dialog': async (c, page) => {
    await c.open();
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press(c.tab);
      await page.waitForTimeout(50);
      seen.add(await focusInfo(page));
    }
    const inert = await page.evaluate(() => {
      const header = document.querySelector('.gate-header');
      return (
        !!header &&
        (!!header.closest('[inert]') || !!header.closest('[aria-hidden=true]'))
      );
    });
    const layers = new Set([...seen].map((f) => f.split('@')[1] ?? f));
    return {
      pass: !layers.has('page') && !layers.has('body') && inert,
      focused: [...seen].join(' | '),
      backgroundInertOrHidden: inert,
    };
  },
  // A clean dialog opened by keyboard closes on Escape and returns focus to
  // its opener. (WebKit does not focus a link on a mouse click.)
  'escape-clean-restores-focus': async (c, page) => {
    await page.locator('.zen-title').focus();
    await page.keyboard.press('Enter');
    await c.title.waitFor();
    await page.waitForTimeout(250);
    await c.title.focus();
    await page.keyboard.press('Escape');
    await hidden(c.dialog);
    await focusUntil(page, /@page$/);
    const s = await c.state();
    return {
      pass: !s.dialogOpen && /^a"/.test(s.focus) && s.focus.endsWith('@page'),
      ...s,
    };
  },
  // After a cancelled close, an explicit Save still works.
  'save-after-cancels': async (c, page) => {
    await c.open();
    await c.dirty();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await c.confirm.waitFor({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await hidden(c.confirm);
    await c.dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await c.dialog.waitFor({ state: 'detached', timeout: 10000 });
    // The list reloads after the close.
    await shown(page.locator('.zen-title', { hasText: EDIT }));
    const saved = await page.locator('.zen-title').first().textContent();
    const s = await c.state();
    return {
      pass: !s.dialogOpen && !!saved?.endsWith(EDIT),
      savedTitle: saved,
      ...s,
    };
  },
  // Closed right after opening: it goes, nothing stays mounted.
  'close-right-after-open': async (c, page) => {
    await page.locator('.zen-title').click();
    await c.title.waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await c.dialog
      .waitFor({ state: 'detached', timeout: 10000 })
      .catch(() => {});
    const s = await c.state();
    return { pass: !s.dialogOpen && (await c.dialog.count()) === 0, ...s };
  },
  // A menu and a date chooser closed during their entry animation: they go
  // (React Aria unmounts an overlay only when its exit animation ends).
  'menu-close-right-after-open': async (c, page) => {
    await c.open();
    await page.getByRole('button', { name: 'Task menu' }).click();
    await page.getByRole('menu').waitFor();
    await page.keyboard.press('Escape');
    const gone = await hidden(page.getByRole('menu'));
    const s = await c.state();
    return { pass: gone && s.dialogOpen, menuGone: gone, ...s };
  },
  'chooser-close-right-after-open': async (c, page) => {
    await c.open();
    await page.getByRole('button', { name: /^Start considering:/ }).click();
    await page.getByRole('grid').waitFor();
    await page.keyboard.press('Escape');
    const gone = await hidden(page.getByRole('grid'));
    const s = await c.state();
    return { pass: gone && s.dialogOpen, chooserGone: gone, ...s };
  },
  // Phone and desktop width while editing: no remount, the draft stays, full
  // screen on the phone.
  'resize-keeps-draft': async (c, page) => {
    await c.open();
    await c.dirty();
    await page.setViewportSize({ width: 375, height: 760 });
    await page.waitForTimeout(300);
    const phone = await c.dialog.boundingBox();
    const s1 = await c.state();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    const s = await c.state();
    return {
      pass: s1.draftKept && s.draftKept && !!phone && phone.width >= 370,
      phoneWidth: phone?.width,
      ...s,
    };
  },
  // Back closes the routed dialog; Forward opens it again.
  'back-forward': async (c, page) => {
    await c.open();
    await page.goBack();
    const back = !(await hidden(c.dialog));
    await page.goForward();
    const forward = await shown(c.title);
    return {
      pass: !back && forward,
      openAfterBack: back,
      openAfterForward: forward,
    };
  },
  // Back with a dirty draft asks through the SDK's navigate; staying keeps
  // the dialog, the draft and the address.
  'back-dirty-stay': async (c, page) => {
    await c.open();
    await c.dirty();
    const address = addressOf(page);
    await page.goBack();
    const asked = await answerLeave(page, 'keep');
    await page.waitForTimeout(300);
    const s = await c.state();
    const kept = addressOf(page) === address;
    return {
      pass: asked && s.dialogOpen && s.draftKept && !s.confirmOpen && kept,
      asked,
      addressKept: kept,
      ...s,
    };
  },
  // Back with a dirty draft, then discard: the dialog closes.
  'back-dirty-discard': async (c, page) => {
    await c.open();
    await c.dirty();
    await page.goBack();
    const asked = await answerLeave(page, 'discard');
    await hidden(c.dialog);
    const s = await c.state();
    const left = !new URL(page.url()).pathname.startsWith('/tasks/');
    return {
      pass: asked && !s.dialogOpen && !s.confirmOpen && left,
      asked,
      left,
      ...s,
    };
  },
};

/**
 * Stage 1 of the spike: the dialog around an SDK editor, its 15 checks plus
 * menus and date choosers closed right after opening.
 */
async function gate({ browser, origin, engine }) {
  const tab = tabKey(engine);
  const { context, page, errors } = await newPage(browser);
  await signIn(page, origin);
  const c = {
    tab,
    dialog: page.getByRole('dialog', { name: 'Details' }),
    confirm: page.getByRole('alertdialog'),
    title: page.getByLabel('Title', { exact: true }),
    open: () => openTask(page),
    dirty: () => typeEdit(page, c.title),
    async state() {
      await settle(page);
      const dialogOpen = await c.dialog.isVisible();
      return {
        dialogOpen,
        confirmOpen: await c.confirm.isVisible(),
        draftKept: dialogOpen ? await editKept(c.title) : false,
        focus: await focusInfo(page),
      };
    },
  };
  const results = [];
  for (const [id, run] of Object.entries(gateChecks)) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(origin + '/');
    await page.locator('.zen-title').waitFor();
    await fetch(origin + '/__reset');
    results.push(await attemptOn(errors, id, () => run(c, page)));
  }
  results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
  await context.close();
  return results;
}

/** The tasks the fixture Pod stores. */
async function storedTasks(origin) {
  return (await fetch(origin + '/__store')).json();
}

/** The start date as the fixture Pod stores it. */
async function stored(origin, title) {
  const tasks = await storedTasks(origin);
  const task = tasks.find(
    (t) => t.body['https://schema.org/name']?.[0]?.['@value'] === title,
  );
  return { value: task?.body[startDate]?.[0] ?? null, version: task?.version };
}

const roundtripChecks = (page, origin) => {
  const trigger = page.getByRole('button', { name: /^Start considering:/ });
  const closed = () => gone(page.getByRole('dialog', { name: 'Details' }));
  async function openNamed(title) {
    await page.goto(origin + '/list');
    await page.getByRole('link', { name: title }).click();
    await dialogReady(page);
  }
  /** Opens the chooser, moves one day on and applies it, by keyboard. */
  async function chooseNextDay() {
    await trigger.click();
    await page.getByRole('grid').waitFor();
    await settle(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await hidden(page.getByRole('grid'));
  }
  return {
    // Select, Apply, Save; a fresh page reads the stored day back.
    async 'save-and-reread'() {
      const before = await stored(origin, PLUMBER);
      await openNamed(PLUMBER);
      await chooseNextDay();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const saved = await closed();
      const after = await stored(origin, PLUMBER);
      await page.reload();
      await openNamed(PLUMBER);
      const shown = await trigger.getAttribute('aria-label');
      return {
        pass:
          saved &&
          before.value?.['@value'] === '2026-10-28' &&
          after.value?.['@value'] === '2026-10-29' &&
          after.value?.['@type'] === xsd + 'date' &&
          /29 Oct 2026$/.test(shown ?? ''),
        before: before.value,
        after: after.value,
        shownAfterReload: shown,
      };
    },
    // A chooser closed without Apply changes neither draft nor data.
    async 'cancel-chooser'() {
      const before = await stored(origin, PLUMBER);
      await openNamed(PLUMBER);
      await trigger.click();
      await page.getByRole('grid').waitFor();
      await settle(page);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      await hidden(page.getByRole('grid'));
      const shown = await trigger.getAttribute('aria-label');
      const saveEnabled = await page
        .getByRole('button', { name: 'Save', exact: true })
        .isEnabled();
      const after = await stored(origin, PLUMBER);
      return {
        pass:
          /28 Oct 2026$/.test(shown ?? '') &&
          !saveEnabled &&
          after.version === before.version &&
          after.value?.['@value'] === '2026-10-28',
        shown,
        saveEnabled,
        after: after.value,
      };
    },
    // A day applied, then the edit cancelled: nothing is written.
    async 'cancel-edit'() {
      const before = await stored(origin, PLUMBER);
      await openNamed(PLUMBER);
      await chooseNextDay();
      const changed = /29 Oct 2026$/.test(
        (await trigger.getAttribute('aria-label')) ?? '',
      );
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      const gone = await closed();
      const after = await stored(origin, PLUMBER);
      return {
        pass:
          changed &&
          gone &&
          after.version === before.version &&
          after.value?.['@value'] === '2026-10-28',
        changed,
        gone,
        after: after.value,
      };
    },
    // A stored zoned xsd:dateTime keeps its lexical value and datatype after a
    // title edit and a cancelled chooser; applying a day replaces it with an
    // xsd:date. The chooser starts at the day of the stored offset.
    async 'zoned-datetime'() {
      const before = await stored(origin, TRAIN);
      await openNamed(TRAIN);
      await trigger.click();
      await page.getByRole('grid').waitFor();
      await settle(page);
      const startDay = await page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label'),
      );
      await page.keyboard.press('Escape');
      const title = page.getByLabel('Title', { exact: true });
      await title.fill(TRAIN + EDIT);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await closed();
      const kept = await stored(origin, TRAIN + EDIT);
      await openNamed(TRAIN + EDIT);
      await chooseNextDay();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await closed();
      const replaced = await stored(origin, TRAIN + EDIT);
      return {
        pass:
          before.value?.['@value'] === '2026-10-30T09:30:00+02:00' &&
          before.value?.['@type'] === xsd + 'dateTime' &&
          kept.value?.['@value'] === before.value['@value'] &&
          kept.value?.['@type'] === before.value['@type'] &&
          /30 October 2026/.test(startDay ?? '') &&
          replaced.value?.['@value'] === '2026-10-31' &&
          replaced.value?.['@type'] === xsd + 'date',
        chooserStartsAt: startDay,
        afterTitleEdit: kept.value,
        afterApplyingADay: replaced.value,
      };
    },
  };
};

/** Calendar-date persistence with the SDK's date field, in three zones. */
async function roundtrip({ browser, origin }) {
  const results = [];
  for (const timezoneId of [
    'Europe/Berlin',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
  ]) {
    const { context, page } = await newPage(browser, { timezoneId });
    await signIn(page, origin);
    for (const [id, run] of Object.entries(roundtripChecks(page, origin))) {
      await fetch(origin + '/__reset');
      results.push(await attempt(id, run, { timezoneId }));
    }
    await context.close();
  }
  return results;
}

const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el && el !== document.body
      ? `${el.getAttribute('role') ?? el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`
      : 'body';
  });

/** Moves the focus down a menu until it is on the named item. */
async function focusItem(page, name) {
  for (let i = 0; i < 6 && !new RegExp(name).test(await focused(page)); i++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
  }
}

/**
 * The date chooser's targets on a phone, also on a short screen: days and
 * month buttons at least 44 × 44px without overlap, Apply and Remove date
 * visible as it opens, no horizontal overflow, Apply reachable by Tab and
 * visible, focus back on the trigger.
 */
async function calendarTargets(page, origin, height, tab) {
  // Sizes as they settle, not halfway through the popover's zoom-in, which
  // headless WebKit on Linux can stretch over seconds.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  try {
    await page.setViewportSize({ width: 375, height });
    await page.goto(origin + '/');
    await openTask(page);
    const trigger = page.getByRole('button', { name: /^Start considering:/ });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('grid').waitFor();
    await settle(page);
    const boxes = await page.evaluate(() => {
      const grid = document.querySelector('[role=grid]');
      const popup = grid.closest('[data-slot=popover-content]');
      const days = [...grid.querySelectorAll('[role=gridcell] > *')].map((el) =>
        el.getBoundingClientRect(),
      );
      const nav = [...popup.querySelectorAll('[slot=previous], [slot=next]')]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0);
      const overlap = (a, b) =>
        a.x < b.x + b.width - 0.5 &&
        b.x < a.x + a.width - 0.5 &&
        a.y < b.y + b.height - 0.5 &&
        b.y < a.y + a.height - 0.5;
      let overlaps = 0;
      for (let i = 0; i < days.length; i++)
        for (let j = i + 1; j < days.length; j++)
          if (overlap(days[i], days[j])) overlaps++;
      const p = popup.getBoundingClientRect();
      // Apply and Remove date, as the chooser opens: inside the screen and on
      // top at their centre, without scrolling.
      const actions = [...popup.querySelectorAll('button')]
        .filter((b) => /^(Apply|Remove date)$/.test(b.textContent ?? ''))
        .map((b) => {
          const r = b.getBoundingClientRect();
          const hit = document.elementFromPoint(
            r.x + r.width / 2,
            r.y + r.height / 2,
          );
          return (
            r.top >= 0 &&
            r.bottom <= innerHeight &&
            !!hit &&
            b.contains(hit) &&
            Math.min(r.width, r.height) >= 44
          );
        });
      return {
        actionsOnOpen: actions.length === 2 && actions.every(Boolean),
        dayMin: Math.min(...days.map((r) => Math.min(r.width, r.height))),
        navMin: Math.min(...nav.map((r) => Math.min(r.width, r.height))),
        navCount: nav.length,
        overlaps,
        horizontalOverflow:
          document.scrollingElement.scrollWidth > innerWidth ||
          p.left < 0 ||
          p.right > innerWidth,
      };
    });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    const apply = page.getByRole('button', { name: 'Apply', exact: true });
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await page.keyboard.press(tab);
      reached = await apply.evaluate((el) => el === document.activeElement);
    }
    const applyBox = await apply.boundingBox();
    const applyVisible =
      !!applyBox && applyBox.y >= 0 && applyBox.y + applyBox.height <= height;
    await page.keyboard.press('Enter');
    await hidden(page.getByRole('grid'));
    const label = await trigger.getAttribute('aria-label');
    const focusBack = /Start considering/.test(
      await focusUntil(page, /Start considering/, focused),
    );
    return {
      pass:
        boxes.actionsOnOpen &&
        boxes.dayMin >= 44 &&
        boxes.navMin >= 44 &&
        boxes.navCount === 2 &&
        boxes.overlaps === 0 &&
        !boxes.horizontalOverflow &&
        reached &&
        applyVisible &&
        /29 Oct 2026/.test(label ?? '') &&
        focusBack,
      ...boxes,
      applyReachedByTab: reached,
      applyVisible,
      label,
      focusBack,
    };
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
}

/** Keyboard use of the header menu and the date chooser; German texts. */
async function interaction({ browser, origin, engine }) {
  const tab = tabKey(engine);
  const { context, page } = await newPage(browser);
  await signIn(page, origin);
  const checks = {
    // Enter opens, ArrowRight opens View, ArrowLeft returns, Escape closes
    // the submenu first, then the menu, with focus back on the button;
    // choosing "List" closes the menu and checks it.
    async 'menu-keyboard'() {
      const menu = page.getByRole('button', { name: 'Menu', exact: true });
      await menu.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'View' }).waitFor();
      await focusItem(page, 'View');
      await page.keyboard.press('ArrowRight');
      await page.getByRole('menuitemradio', { name: 'Zen' }).waitFor();
      const zenChecked = await page
        .getByRole('menuitemradio', { name: 'Zen' })
        .getAttribute('aria-checked');
      await page.keyboard.press('ArrowLeft');
      const submenuClosedLeft = await hidden(
        page.getByRole('menuitemradio', { name: 'List' }),
      );
      await page.keyboard.press('ArrowRight');
      await shown(page.getByRole('menuitemradio', { name: 'List' }));
      await page.keyboard.press('Escape');
      await hidden(page.getByRole('menuitemradio', { name: 'List' }));
      const menuOpenAfterSubEscape = await page
        .getByRole('menuitem', { name: 'View' })
        .isVisible();
      if (menuOpenAfterSubEscape) {
        await page.keyboard.press('Escape');
        await hidden(page.getByRole('menu'));
      }
      const backOnTrigger = /Menu/.test(
        await focusUntil(page, /Menu/, focused),
      );
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'View' }).waitFor();
      await focusItem(page, 'View');
      await page.keyboard.press('ArrowRight');
      await page.getByRole('menuitemradio', { name: 'List' }).waitFor();
      await focusItem(page, 'List');
      await page.keyboard.press('Enter');
      const menuClosed = await hidden(page.getByRole('menu'));
      const listShown = await shown(page.locator('.gate-list'));
      await menu.click();
      await page.getByRole('menuitem', { name: 'View' }).hover();
      await page.keyboard.press('ArrowRight');
      await page.getByRole('menuitemradio', { name: 'List' }).waitFor();
      const listChecked = await page
        .getByRole('menuitemradio', { name: 'List' })
        .getAttribute('aria-checked');
      return {
        pass:
          zenChecked === 'true' &&
          submenuClosedLeft &&
          backOnTrigger &&
          listShown &&
          menuClosed &&
          listChecked === 'true',
        zenChecked,
        submenuClosedLeft,
        menuOpenAfterSubEscape,
        backOnTrigger,
        listShown,
        menuClosed,
        listChecked,
      };
    },
    // Focus starts on the chosen day; arrows, PageDown, Enter and Apply.
    async 'calendar-keyboard'() {
      await openTask(page);
      const trigger = page.getByRole('button', { name: /^Start considering:/ });
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('grid').waitFor();
      await settle(page);
      const start = await focused(page);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('PageDown');
      await page.keyboard.press('Enter');
      for (let i = 0; i < 6 && !/Apply/.test(await focused(page)); i++)
        await page.keyboard.press(tab);
      await page.keyboard.press('Enter');
      await hidden(page.getByRole('grid'));
      const label = await trigger.getAttribute('aria-label');
      const after = await focusUntil(page, /Start considering/, focused);
      // The seed day is 28 Oct 2026: one day and one month later.
      return {
        pass:
          /28 October 2026/.test(start) &&
          /29 Nov 2026/.test(label ?? '') &&
          /Start considering/.test(after),
        start,
        label,
        after,
      };
    },
    'calendar-targets-375x812': () => calendarTargets(page, origin, 812, tab),
    'calendar-targets-375x560': () => calendarTargets(page, origin, 560, tab),
    // German: month names and Monday first through the SDK locale; the
    // adapters' and the SDK's texts.
    async 'calendar-german'() {
      await page.goto(origin + '/?lang=de');
      await openTask(page);
      await page.getByRole('button', { name: /^Vormerken ab:/ }).click();
      await page.getByRole('grid').waitFor();
      const { heading, firstDay } = await page.evaluate(() => {
        const popup = document
          .querySelector('[role=grid]')
          ?.closest('[data-slot=popover-content]');
        const header = popup?.querySelector('th');
        return {
          heading: popup?.textContent?.slice(0, 40),
          firstDay: header?.getAttribute('aria-label') ?? header?.textContent,
        };
      });
      const apply = await page
        .getByRole('button', { name: 'Übernehmen', exact: true })
        .count();
      const remove = await page
        .getByRole('button', { name: 'Datum entfernen', exact: true })
        .count();
      await page.keyboard.press('Escape');
      const close = await page
        .getByRole('button', { name: 'Schließen', exact: true })
        .count();
      const save = await page
        .getByRole('button', { name: 'Speichern' })
        .count();
      return {
        pass:
          /Oktober/.test(heading ?? '') &&
          /^(Mo|M$)/.test(firstDay?.trim() ?? '') &&
          apply === 1 &&
          remove === 1 &&
          close === 1 &&
          save > 0,
        heading,
        firstDay,
      };
    },
    // Removing the date of the optional field leaves no value in the draft.
    async 'calendar-remove'() {
      await openTask(page);
      const trigger = page.getByRole('button', { name: /^Start considering:/ });
      await trigger.click();
      await page
        .getByRole('button', { name: 'Remove date', exact: true })
        .click();
      await hidden(page.getByRole('grid'));
      const label = await trigger.getAttribute('aria-label');
      const save = page.getByRole('button', { name: 'Save', exact: true });
      const saveEnabled = await save.isEnabled();
      await save.click();
      const closed = await gone(page.getByRole('dialog', { name: 'Details' }));
      const after = await stored(origin, PLUMBER);
      return {
        pass:
          label === 'Start considering: No date' &&
          closed &&
          after.value === null,
        label,
        saveEnabled,
        closed,
        after: after.value,
        dialogText: closed
          ? undefined
          : await page.getByRole('dialog').first().innerText(),
      };
    },
  };
  const results = [];
  for (const [id, run] of Object.entries(checks)) {
    await page.goto(origin + '/');
    await page.locator('.zen-title').waitFor();
    await fetch(origin + '/__reset');
    results.push(await attempt(id, run));
  }
  await context.close();
  return results;
}

/**
 * Tailwind and SDK cascade: the package's classes win over the SDK's element
 * rules inside SDK surfaces (layer order), and the bridge reaches the SDK's
 * own controls.
 */
async function integration({ browser, origin }) {
  const { context, page } = await newPage(browser);
  await signIn(page, origin);
  const results = [];
  results.push(
    await attempt('package-classes-in-sdk-editor', async () => {
      await page.goto(origin + '/?theme=fresh');
      await openTask(page);
      const styles = await page.evaluate(() => {
        const input = document.querySelector('[data-slot=input]');
        const trigger = [...document.querySelectorAll('button')].find((b) =>
          b.getAttribute('aria-label')?.startsWith('Start considering:'),
        );
        const s = (el) => getComputedStyle(el);
        return {
          insideEditor: !!input?.closest('[data-sempods-ui=editor]'),
          // Input: bg-transparent and rounded-lg (utilities) over the SDK's
          // field background and radius.
          inputBackground: s(input).backgroundColor,
          // The outline Button: its 1px border in the border role
          // (utilities) over the SDK's transparent border for buttons.
          triggerBorder: s(trigger).borderTopWidth,
          triggerBorderColor: s(trigger).borderTopColor,
          triggerHeight: s(trigger).height,
        };
      });
      return {
        pass:
          styles.insideEditor &&
          /^(rgba\(0, 0, 0, 0\)|transparent)$/.test(styles.inputBackground) &&
          styles.triggerBorder === '1px' &&
          styles.triggerBorderColor !== 'rgba(0, 0, 0, 0)' &&
          styles.triggerHeight === '44px',
        ...styles,
      };
    }),
  );
  results.push(
    await attempt('sdk-bridge', async () => {
      const values = await page.evaluate(() => {
        const save = [...document.querySelectorAll('button')].find(
          (b) => b.textContent === 'Save',
        );
        const field = document.querySelector('[data-sempods-ui=editor]');
        const probe = document.createElement('div');
        document.body.append(probe);
        const resolve = (v) => {
          probe.style.color = `var(${v})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          savePrimary: getComputedStyle(save).backgroundColor,
          primary: resolve('--primary'),
          fieldLine:
            getComputedStyle(field).getPropertyValue('--sp-field-line'),
          focus: getComputedStyle(field).getPropertyValue('--sp-focus'),
          input: resolve('--input'),
          ring: resolve('--ring'),
        };
        probe.remove();
        return result;
      });
      return {
        pass:
          values.savePrimary === values.primary &&
          values.primary !== 'rgba(0, 0, 0, 0)' &&
          values.fieldLine.trim() !== '' &&
          values.focus.trim() !== '',
        ...values,
      };
    }),
  );
  await page.emulateMedia({ colorScheme: null });
  results.push(
    await attempt('reduced-motion', async () => {
      // The header menu opens with its zoom-in, and without one when the
      // person asks for reduced motion; measured as the menu is inserted,
      // before a 100ms animation could have ended.
      const animations = async (reducedMotion) => {
        await page.emulateMedia({ reducedMotion });
        await page.goto(origin + '/');
        await page.evaluate(() => {
          window.menuAnimation = new Promise((resolve) => {
            const observer = new MutationObserver(() => {
              const menu = document.querySelector(
                '[data-slot=dropdown-menu-content]',
              );
              if (!menu) return;
              observer.disconnect();
              resolve(getComputedStyle(menu).animationName);
            });
            observer.observe(document.body, { childList: true, subtree: true });
          });
        });
        await page.getByRole('button', { name: 'Menu', exact: true }).click();
        const name = await page.evaluate(() => window.menuAnimation);
        await page.keyboard.press('Escape');
        await hidden(page.getByRole('menu'));
        return name;
      };
      try {
        const normal = await animations('no-preference');
        const reduced = await animations('reduce');
        return {
          pass: normal !== 'none' && reduced === 'none',
          normal,
          reduced,
        };
      } finally {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
      }
    }),
  );
  await context.close();
  return results;
}

// [label, expected pass, kind, markup]: known failures must fail and readable
// cases must pass, or the checker's green result means nothing.
const contrastFixtures = [
  [
    'text-white-on-white',
    false,
    'text',
    '<p aria-label="fx" style="color:#fff">Invisible</p>',
  ],
  [
    'text-readable',
    true,
    'text',
    '<p aria-label="fx" style="color:#1f2933">Readable</p>',
  ],
  [
    'text-transparent',
    false,
    'text',
    '<p aria-label="fx" style="color:rgb(0 0 0 / .3)">Faint</p>',
  ],
  [
    'text-oklch',
    true,
    'text',
    '<p aria-label="fx" style="color:oklch(0.3 0.02 250)">Oklch</p>',
  ],
  [
    'text-large-3to1',
    true,
    'text-large',
    '<p aria-label="fx" style="color:#949494;font-size:24px">Large</p>',
  ],
  [
    'text-small-3to1',
    false,
    'text',
    '<p aria-label="fx" style="color:#949494;font-size:16px">Small</p>',
  ],
  [
    'value-white-on-white',
    false,
    'field-value',
    '<input aria-label="fx" value="Hidden" style="color:#fff;background:#fff;border:1px solid #767676">',
  ],
  [
    'value-readable',
    true,
    'field-value',
    '<input aria-label="fx" value="Shown" style="color:#1f2933;border:1px solid #767676">',
  ],
  [
    'textarea-low',
    false,
    'field-value',
    '<textarea aria-label="fx" style="color:#999;border:1px solid #767676">Grey</textarea>',
  ],
  [
    'placeholder-low',
    false,
    'placeholder',
    '<style>#ph1::placeholder{color:#ccc;opacity:1}</style><input id="ph1" aria-label="fx" placeholder="Hint" style="border:1px solid #767676">',
  ],
  [
    'placeholder-readable',
    true,
    'placeholder',
    '<style>#ph2::placeholder{color:#595959;opacity:1}</style><input id="ph2" aria-label="fx" placeholder="Hint" style="border:1px solid #767676">',
  ],
  [
    'icon-low',
    false,
    'icon',
    '<button aria-label="fx" style="border:0;background:#fff"><svg width="20" height="20" style="stroke:#ccc"><path d="M2 2L18 18" /></svg></button>',
  ],
  [
    'icon-readable',
    true,
    'icon',
    '<button aria-label="fx" style="border:0;background:#fff"><svg width="20" height="20" style="stroke:#333"><path d="M2 2L18 18" /></svg></button>',
  ],
  [
    'boundary-low',
    false,
    'field-boundary',
    '<input aria-label="fx" style="border:1px solid #eee;color:#000" value="x">',
  ],
  [
    'boundary-readable',
    true,
    'field-boundary',
    '<input aria-label="fx" style="border:1px solid #767676;color:#000" value="x">',
  ],
];
const focusFixtures = [
  [
    'focus-ring-50-teal',
    false,
    '<button aria-label="fx" class="f" style="--c:rgb(10 102 128 / .5)">Teal ring</button>',
  ],
  [
    'focus-outline-solid',
    true,
    '<button aria-label="fx" class="o">Solid</button>',
  ],
  [
    'focus-outline-low',
    false,
    '<button aria-label="fx" class="l">Low</button>',
  ],
];
const fixtureCss = `<style>body{margin:16px;background:#fff;color:#000;font:16px system-ui}
.f:focus-visible{outline:none;box-shadow:0 0 0 3px var(--c)}
.o:focus-visible{outline:2px solid #1f2933;outline-offset:2px}
.l:focus-visible{outline:2px solid #ddd;outline-offset:2px}</style>`;

// The rendered states of the reference screen.
const states = {
  async zen(page) {
    await page.locator('.zen-title').waitFor();
  },
  async menu(page) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'View' }).focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('menuitemradio', { name: 'List' }).waitFor();
  },
  dialog: openTask,
  async date(page) {
    await states.dialog(page);
    await page.getByRole('button', { name: /^Start considering:/ }).click();
    await page.getByRole('grid').waitFor();
  },
  async confirm(page) {
    await states.dialog(page);
    await page.getByLabel('Title', { exact: true }).fill('Changed title');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('alertdialog').waitFor();
  },
};
// Both palettes (the package default and the app's "fresh") with every
// action and secondary variant at least once.
const variants = [
  ['default', 'solid', 'tonal'],
  ['default', 'inverted', 'outline'],
  ['fresh', 'solid', 'text'],
  ['fresh', 'inverted', 'tonal'],
];
const combos = process.env.UI_COMBOS === '0' ? [] : variants;
/** Signed-in pages that measure the contrast checks side by side. */
const contrastPages = 4;

/**
 * Rendered contrast (scripts/ui-contrast.js): its controls first, then each
 * state × palette and variants × light and dark × 375 and 1280px. Zen actions
 * are also measured hovered and pressed; controls reached by Tab with their
 * focus indicator. A measurement of these states, not a full audit.
 */
async function contrast({ browser, origin, engine }) {
  const tab = tabKey(engine);
  const results = [];
  {
    const { context, page } = await newPage(browser);
    for (const [label, expected, kind, markup] of contrastFixtures) {
      await page.setContent(
        `<!doctype html>${fixtureCss}<body>${markup}</body>`,
      );
      await page.addScriptTag({ content: contrastScript });
      const hit = (await page.evaluate(() => window.uiContrast())).find(
        (r) => r.kind === kind && r.what.includes('"fx"'),
      );
      results.push({
        id: `control-${label}`,
        pass: !!hit && hit.pass === expected,
        measured: hit,
      });
    }
    for (const [label, expected, markup] of focusFixtures) {
      await page.setContent(
        `<!doctype html>${fixtureCss}<body><button>before</button>${markup}</body>`,
      );
      await page.addScriptTag({ content: contrastScript });
      await page.keyboard.press(tab);
      await page.keyboard.press(tab);
      await page.waitForTimeout(50);
      const hit = await page.evaluate(() => window.uiFocusIndicator());
      results.push({
        id: `control-${label}`,
        pass: !!hit && hit.pass === expected,
        measured: hit,
      });
    }
    await context.close();
  }
  // The reported blind spot: the task title made white on white must fail.
  const whiteOnWhite = (page) =>
    attempt('control-app-title-white-on-white', async () => {
      await states.dialog(page);
      await page.waitForTimeout(300);
      const failing = () =>
        page.evaluate(
          () =>
            window
              .uiContrast()
              .filter((r) => r.kind === 'field-value' && !r.pass).length,
        );
      const before = await failing();
      await page.getByLabel('Title', { exact: true }).evaluate((el) => {
        el.style.setProperty('color', '#fff', 'important');
        el.style.setProperty('background-color', '#fff', 'important');
      });
      // The input's colours transition (transition-colors, 150ms).
      await page.waitForTimeout(400);
      const after = await failing();
      return { pass: before === 0 && after === 1, before, after };
    });
  const checks = [whiteOnWhite];
  for (const [theme, actions, secondary] of combos) {
    const query = `?theme=${theme}&actions=${actions}&secondary=${secondary}`;
    for (const scheme of ['light', 'dark'])
      for (const [state, reach] of Object.entries(states))
        for (const width of [375, 1280]) {
          const id = `${theme}/${actions}/${secondary} ${scheme} ${state} ${width}`;
          checks.push((page) =>
            attempt(id, async () => {
              await page.emulateMedia({ colorScheme: scheme });
              await page.setViewportSize({
                width,
                height: width < 600 ? 812 : 800,
              });
              await page.goto(origin + '/' + query);
              await reach(page);
              await settle(page);
              const measured = await page.evaluate(() => window.uiContrast());
              const tagged = (list, suffix) =>
                list.map((m) => ({ ...m, what: `${m.what} ${suffix}` }));
              if (state === 'zen')
                for (const name of ['Complete', 'Not today', 'Previous task']) {
                  const target = page.getByRole('button', {
                    name,
                    exact: true,
                  });
                  await target.hover();
                  await settle(page);
                  measured.push(
                    ...tagged(
                      await target.evaluate((el) => window.uiContrast(el)),
                      ':hover',
                    ),
                  );
                  // Pressed, released away from the button: nothing runs.
                  await page.mouse.down();
                  await settle(page);
                  measured.push(
                    ...tagged(
                      await target.evaluate((el) => window.uiContrast(el)),
                      ':active',
                    ),
                  );
                  await page.mouse.move(1, 1);
                  await page.mouse.up();
                }
              const focus = [];
              for (let i = 0; i < 8; i++) {
                await page.keyboard.press(tab);
                await settle(page);
                const f = await page.evaluate(() => window.uiFocusIndicator());
                if (f && !focus.some((x) => x.what === f.what)) {
                  focus.push(f);
                  measured.push(
                    ...tagged(
                      await page.evaluate(() =>
                        window.uiContrast(document.activeElement),
                      ),
                      ':focus',
                    ),
                  );
                }
              }
              const failures = [
                ...new Map(
                  measured
                    .filter((m) => !m.pass)
                    .map((f) => [f.kind + f.what + f.fg + f.bg, f]),
                ).values(),
              ];
              const min = (kind) =>
                Math.min(
                  ...measured
                    .filter((m) => m.kind === kind)
                    .map((m) => m.ratio),
                );
              // The SDK's actions are measured too: Cancel in the editor,
              // both answers of the confirmation.
              const sdkActions = new Set(
                measured
                  .filter((m) => m.what.startsWith('button[sdk:'))
                  .map((m) => m.what),
              ).size;
              const sdkNeeded = { dialog: 1, confirm: 2 }[state] ?? 0;
              return {
                pass:
                  measured.length > 0 &&
                  failures.length === 0 &&
                  sdkActions >= sdkNeeded &&
                  focus.every((f) => f.pass),
                sdkActions,
                checked: measured.length,
                minText: min('text'),
                minIcon: min('icon'),
                minField: min('field-boundary'),
                minFocus: Math.min(...focus.map((f) => f.ratio)),
                failures,
                focusFailures: focus.filter((f) => !f.pass),
              };
            }),
          );
        }
  }
  // Each check loads its own state, so the checks share a few signed-in pages
  // and run side by side; the results keep their order.
  const measured = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: contrastPages }, async () => {
      // Colours as they settle, not halfway through a fade-in (see calendarTargets).
      const { context, page } = await newPage(browser, {
        reducedMotion: 'reduce',
      });
      try {
        await context.addInitScript(contrastScript);
        await signIn(page, origin);
        for (let i = next++; i < checks.length; i = next++)
          measured[i] = await checks[i](page);
      } finally {
        await context.close();
      }
    }),
  );
  results.push(...measured);
  return results;
}

/** Whether `condition` holds within the time (default 10s), polled. */
async function until(page, condition, timeout = 10000) {
  for (const end = Date.now() + timeout; ;) {
    if (await condition().catch(() => false)) return true;
    if (Date.now() > end) return false;
    await page.waitForTimeout(50);
  }
}

/** The task's routing matrix, from the template's routing spike #114. */
const routingChecks = (page, origin) => {
  const { iri: task, id, at, work, personal } = plumberTask(origin);
  const withSource = (context, action = '') =>
    `${at}${action}?context=${encodeURIComponent(context)}`;
  const details = page.getByRole('dialog', { name: /^(Details|Not today)$/ });
  const title = details.getByLabel('Title', { exact: true });
  const closeButton = details.getByRole('button', {
    name: 'Close',
    exact: true,
  });
  const confirm = page.getByRole('alertdialog');
  const notFound = page.getByRole('dialog', { name: 'Not found' });
  const zenTitle = page.locator('.zen-title');
  const plumberLink = page.getByRole('link', { name: /^Call the plumber/ });
  // Decoded, so the router's percent-encoding of the same address compares
  // equal.
  const url = () => new URL(page.url());
  const path = () => decodeURIComponent(addressOf(page));
  const pathname = () => url().pathname;
  const historyLength = () => page.evaluate(() => history.length);
  const isTask = (p) =>
    p.startsWith('/tasks/') && !/^\/tasks\/(add|new)$/.test(p);
  /** What is shown matches the address: the task dialog exactly on tasks. */
  const consistent = async () =>
    (await details.isVisible()) === isTask(pathname());
  /** The address is `expected`, and the task dialog is open or not. */
  const showing = (expected, open) => async () =>
    path() === expected && (await details.isVisible()) === open;
  /** On the task's address with its dialog open. */
  const onTask = async () => pathname() === at && (await title.isVisible());
  const dirty = () => typeEdit(page, title);
  const overview = async () => {
    await page.goto(origin + '/');
    await zenTitle.waitFor();
  };
  const openFromOverview = async () => {
    await page.goto(origin + '/');
    await zenTitle.click();
    await title.waitFor();
  };
  // Zen, then List through the menu: two entries of the same document.
  const toList = async () => {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'View' }).click();
    await page.getByRole('menuitemradio', { name: 'List' }).click();
    await plumberLink.waitFor();
  };
  const toListInApp = async () => {
    await overview();
    await toList();
  };
  /** Opens the task from the list. */
  const openFromList = async () => {
    await plumberLink.click();
    await title.waitFor();
  };
  const answer = (choice) => answerLeave(page, choice);
  /** The task's name in a Context, among the stored tasks. */
  const nameIn = (tasks, context) =>
    tasks.find((t) => t.context === context && t.body['@id'] === task)?.body[
      'https://schema.org/name'
    ]?.[0]?.['@value'];
  return {
    async 'direct-entry-signed-in'() {
      await page.goto(origin + at);
      await title.waitFor();
      const read = await title.inputValue();
      return { pass: read === PLUMBER && path() === at, read, path: path() };
    },
    // A plain click switches in place: no reload, the source in the address.
    async 'link-plain-click-in-place'() {
      await overview();
      await page.evaluate(() => (window.marker = 'kept'));
      const href = await zenTitle.getAttribute('href');
      await zenTitle.click();
      await title.waitFor();
      const marker = await page.evaluate(() => window.marker);
      return {
        pass:
          href === withSource(work) &&
          path() === decodeURIComponent(withSource(work)) &&
          marker === 'kept',
        href,
        path: path(),
        noReload: marker === 'kept',
      };
    },
    async 'link-modified-click-new-tab'() {
      await overview();
      const opened = page.context().waitForEvent('page', { timeout: 5000 });
      await zenTitle.click({ modifiers: ['ControlOrMeta'] });
      const tab = await opened.catch(() => null);
      await tab?.waitForURL(/\/tasks\//).catch(() => {});
      const tabPath = tab ? new URL(tab.url()).pathname : null;
      await tab?.close();
      const open = await details.isVisible();
      return {
        pass: tabPath === at && path() === '/' && !open,
        newTab: tabPath,
        stayed: path(),
        open,
      };
    },
    async 'action-route'() {
      await page.goto(origin + '/');
      await page
        .getByRole('button', { name: 'Not today', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Not today' })
        .getByLabel('Title', { exact: true })
        .waitFor();
      return { pass: pathname() === at + '/postpone', path: path() };
    },
    async 'close-returns-to-opener'() {
      await page.goto(origin + '/list');
      await openFromList();
      const before = await historyLength();
      await closeButton.click();
      const back = await until(page, showing('/list', false));
      return {
        pass: back && (await plumberLink.isVisible()),
        path: path(),
        historyLength: [before, await historyLength()],
      };
    },
    async 'close-direct-entry-falls-back'() {
      await page.goto(origin + at);
      await title.waitFor();
      const before = await historyLength();
      await closeButton.click();
      const back = await until(page, showing('/', false));
      const after = await historyLength();
      return {
        pass: back && after === before,
        path: path(),
        historyLength: [before, after],
      };
    },
    async 'back-dirty-stay'() {
      await openFromOverview();
      await dirty();
      await page.goBack();
      const asked = await answer('keep');
      const stayed = await until(page, async () => pathname() === at);
      const kept = await editKept(title);
      return {
        pass: asked && stayed && kept,
        asked,
        draftKept: kept,
        path: path(),
      };
    },
    async 'back-dirty-discard'() {
      await openFromOverview();
      await dirty();
      await page.goBack();
      const asked = await answer('discard');
      const left = await until(page, showing('/', false));
      return { pass: asked && left, asked, path: path() };
    },
    async 'back-forward-clean'() {
      await openFromOverview();
      await page.goBack();
      const back = await until(page, showing('/', false));
      await page.goForward();
      const forward = await until(page, onTask);
      return { pass: back && forward, back, forward, path: path() };
    },
    // The legacy link becomes the canonical address by replacement.
    async 'legacy-query-link'() {
      await overview();
      const before = await historyLength();
      await page.goto(origin + '/?task=' + id);
      await title.waitFor();
      const canonical = await until(page, async () => path() === at);
      const after = await historyLength();
      return {
        pass: canonical && after === before + 1,
        path: path(),
        historyLength: [before, after],
      };
    },
    async 'not-found-and-invalid'() {
      await page.goto(origin + '/nowhere');
      const unknown = await notFound.textContent().catch(() => null);
      await loaded(page);
      await page.goto(origin + '/tasks/!!!');
      const invalid = await notFound.textContent().catch(() => null);
      return {
        pass:
          /does not lead/.test(unknown ?? '') &&
          /not valid/.test(invalid ?? '') &&
          path() === '/tasks/!!!',
        unknown,
        invalid,
      };
    },
    async 'reload-keeps-resource'() {
      await openFromOverview();
      await page.reload();
      await title.waitFor();
      return {
        pass: path() === decodeURIComponent(withSource(work)),
        path: path(),
      };
    },
    async 'menu-switches-view'() {
      await overview();
      await toList();
      return { pass: path() === '/list', path: path() };
    },

    // History moves while the SDK's question is open (Codex, template #121).
    async 'pending-back-forward-discard'() {
      await openFromOverview();
      await dirty();
      await page.goBack();
      await confirm.waitFor({ timeout: 3000 });
      await page.goForward();
      const asked = await answer('discard');
      const settled = await until(page, consistent);
      const state = { path: pathname(), open: await details.isVisible() };
      const kept = state.open && (await editKept(title));
      await page.goBack();
      const left = await until(page, showing('/', false));
      const askedAgain = await confirm.isVisible();
      return {
        pass: asked && settled && !kept && left && !askedAgain,
        state,
        draftKept: kept,
        askedAgain,
      };
    },
    async 'pending-back-forward-keep'() {
      await openFromOverview();
      await dirty();
      await page.goBack();
      await confirm.waitFor({ timeout: 3000 });
      await page.goForward();
      const asked = await answer('keep');
      const kept = await editKept(title);
      const stayed = await until(page, onTask);
      // The history still works: Back asks again.
      await page.goBack();
      const again = await answer('keep');
      const stillThere = await until(page, async () => pathname() === at);
      return {
        pass: asked && kept && stayed && again && stillThere,
        draftKept: kept,
        asksAgain: again,
        path: path(),
      };
    },
    async 'repeated-back-keep'() {
      await toListInApp();
      await openFromList();
      await dirty();
      await page.goBack();
      await confirm.waitFor({ timeout: 3000 });
      await page.goBack();
      const asked = await answer('keep');
      const stayed = await until(page, onTask);
      const kept = await editKept(title);
      return { pass: asked && stayed && kept, draftKept: kept, path: path() };
    },
    async 'repeated-back-discard'() {
      await toListInApp();
      await openFromList();
      await dirty();
      await page.goBack();
      await confirm.waitFor({ timeout: 3000 });
      await page.goBack();
      const asked = await answer('discard');
      const left = await until(page, showing('/', false));
      await page.goForward();
      const forward = await until(page, showing('/list', false));
      return { pass: asked && left && forward, left, forward, path: path() };
    },
    async 'multi-entry-traversal'() {
      await toListInApp();
      await openFromList();
      await page.evaluate(() => history.go(-2));
      const back = await until(page, showing('/', false));
      await page.evaluate(() => history.go(2));
      const forward = await until(page, onTask);
      return { pass: back && forward, back, forward, path: path() };
    },
    async 'reload-then-back'() {
      await openFromOverview();
      await page.reload();
      await title.waitFor();
      await page.goBack();
      const back = await until(page, showing('/', false));
      await page.goForward();
      const forward = await until(page, onTask);
      return { pass: back && forward, back, forward, path: path() };
    },
    // A fragment link adds an entry the router did not write (Codex, #208):
    // staying after two entries back returns to the task, not to the
    // fragment entry.
    async 'fragment-entry-back-keep'() {
      await toListInApp();
      await page.evaluate(() => (location.hash = 'section'));
      await until(page, async () => url().hash === '#section');
      await plumberLink.click();
      await title.waitFor();
      await dirty();
      await page.evaluate(() => history.go(-2));
      const asked = await answer('keep');
      const stayed = await until(
        page,
        async () =>
          pathname() === at && url().hash === '' && (await consistent()),
      );
      const kept = await editKept(title);
      return {
        pass: asked && stayed && kept,
        asked,
        draftKept: kept,
        url: page.url(),
      };
    },
    // Close after a fragment link's entry still returns to the opener
    // (Codex, #208), past the screen's fragment entry.
    async 'fragment-entry-close'() {
      await page.goto(origin + '/list');
      await openFromList();
      await page.evaluate(() => (location.hash = 'notes'));
      await until(page, async () => url().hash === '#notes');
      await closeButton.click();
      const back = await until(
        page,
        async () => (await showing('/list', false)()) && url().hash === '',
      );
      return { pass: back && (await plumberLink.isVisible()), url: page.url() };
    },
    // A replaced fragment keeps the entry (Codex, #208): Close still returns
    // to the opener, not one entry further.
    async 'fragment-replace-close'() {
      await page.goto(origin + '/list');
      await openFromList();
      await page.evaluate(() => location.replace('#notes'));
      await until(page, async () => url().hash === '#notes');
      await closeButton.click();
      const back = await until(
        page,
        async () => (await showing('/list', false)()) && url().hash === '',
      );
      return { pass: back && (await plumberLink.isVisible()), url: page.url() };
    },
    // A path that starts with two slashes stays a path of this origin
    // (Codex, #208): its explicit page, no cross-origin history write.
    async 'double-slash-not-found'() {
      await page.goto(origin + '//unknown/path');
      const text = await notFound.textContent().catch(() => null);
      return {
        pass: /does not lead/.test(text ?? '') && path() === '//unknown/path',
        text,
        path: path(),
      };
    },
    // An invalid legacy link keeps its address and its error page.
    async 'invalid-legacy-stays'() {
      await page.goto(origin + '/?task=!!!');
      const text = await notFound.textContent().catch(() => null);
      return {
        pass: /not valid/.test(text ?? '') && path() === '/?task=!!!',
        text,
        path: path(),
      };
    },
    // The literal creation route wins over the resource pattern; its legacy
    // form becomes canonical.
    async 'creation-route-wins'() {
      const creation = page.getByRole('dialog', { name: 'New task' });
      await page.goto(origin + '/tasks/add');
      const add = await shown(creation);
      await loaded(page);
      await page.goto(origin + '/tasks/new');
      const legacy = await shown(creation);
      const canonical = await until(page, async () => path() === '/tasks/add');
      return { pass: add && legacy && canonical, path: path() };
    },

    // The source Context in the address (Codex, template #121): two Contexts
    // hold the same subject; reads and writes go to the one the address names.
    async 'source-named-in-links'() {
      await overview();
      const href = await zenTitle.getAttribute('href');
      return { pass: href === withSource(work), href };
    },
    async 'source-signed-in-read-and-write'() {
      await page.goto(origin + withSource(personal));
      await title.waitFor();
      const read = await title.inputValue();
      await title.fill('Personal copy, edited');
      await details.getByRole('button', { name: 'Save', exact: true }).click();
      await gone(details);
      const tasks = await storedTasks(origin);
      const personalNow = nameIn(tasks, personal);
      const workNow = nameIn(tasks, work);
      return {
        pass:
          read === PERSONAL &&
          personalNow === 'Personal copy, edited' &&
          workNow === PLUMBER,
        read,
        personalNow,
        workNow,
      };
    },
    async 'source-action-route'() {
      await page.goto(origin + withSource(personal, '/postpone'));
      const field = page
        .getByRole('dialog', { name: 'Not today' })
        .getByLabel('Title', { exact: true });
      await field.waitFor();
      const read = await field.inputValue();
      return { pass: read === PERSONAL, read };
    },
    async 'source-reload'() {
      await page.goto(origin + withSource(personal));
      await title.waitFor();
      await page.reload();
      await title.waitFor();
      const read = await title.inputValue();
      return {
        pass:
          path() === decodeURIComponent(withSource(personal)) &&
          read === PERSONAL,
        read,
        path: path(),
      };
    },
    // A named source the app cannot read: an explicit error, no editor in
    // another Context.
    async 'source-unavailable'() {
      await page.goto(
        origin + withSource(origin + '/alice/_system/contexts/nope'),
      );
      const alert = await shown(details.getByRole('alert'));
      const text = await details.getByRole('alert').textContent();
      const editors = await title.count();
      return {
        pass: alert && /not available/.test(text ?? '') && editors === 0,
        text,
        editors,
      };
    },
  };
};

/**
 * The routing matrix of the template's routing spike (#114, branch
 * claude/120-ui-spike, scripts/routing-gate.mjs): 29 checks of addresses,
 * links and history moves with the package's router, three of them signed
 * out, plus five from the reviews of #208: an unreadable source signed out,
 * fragment entries added and replaced, and a path with two leading slashes.
 * Each history check asserts the address and what is shown together.
 */
async function routing({ browser, origin }) {
  const results = [];
  const { at, personal } = plumberTask(origin);
  const sourced = (source) => `${at}?context=${encodeURIComponent(source)}`;
  // A title the task dialog shows, an alert in it, or the Not found text.
  // An address that names its source opens without a Context choice.
  const signedOut = [
    ['direct-entry-signed-out', at, { title: PLUMBER }],
    [
      'source-signed-out',
      sourced(personal),
      { title: PERSONAL, choose: false },
    ],
    [
      'source-unavailable-signed-out',
      sourced(origin + '/alice/_system/contexts/nope'),
      { alert: /not available/, choose: false },
    ],
    ['invalid-legacy-signed-out', '/?task=!!!', { notFound: /not valid/ }],
  ];
  for (const [id, address, expected] of signedOut) {
    const { context, page, errors } = await newPage(browser);
    results.push(
      await attempt(id, async () => {
        const choose = expected.choose ?? true;
        await signIn(page, origin, address, { choose });
        const details = page.getByRole('dialog', { name: 'Details' });
        let shows;
        if (expected.notFound)
          shows = expected.notFound.test(
            (await page
              .getByRole('dialog', { name: 'Not found' })
              .textContent()) ?? '',
          );
        else if (expected.alert)
          shows = expected.alert.test(
            (await details.getByRole('alert').textContent()) ?? '',
          );
        else {
          const field = details.getByLabel('Title', { exact: true });
          await field.waitFor();
          shows = (await field.inputValue()) === expected.title;
        }
        const asked = !choose && (await chooser(page).isVisible());
        const path = addressOf(page);
        return {
          pass: path === address && shows && !asked && errors.length === 0,
          path,
          chooserShown: asked,
          errors,
        };
      }),
    );
    await context.close();
  }
  const { context, page, errors } = await newPage(browser);
  // A draft left by one check must not hold the next one's page load.
  page.on('dialog', (dialog) => void dialog.accept().catch(() => {}));
  await signIn(page, origin);
  for (const [id, run] of Object.entries(routingChecks(page, origin))) {
    // The previous check's page finishes its reads before the next navigation.
    await loaded(page).catch(() => {});
    await fetch(origin + '/__reset');
    results.push(await attemptOn(errors, id, run));
  }
  results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
  await context.close();
  return results;
}

// Compare the packaged checker with the paint of both real button implementations.
// Canvas uses the same 8-bit sRGB output as a ThemeSample.
async function theme({ browser, origin }) {
  const { context, page } = await newPage(browser, { reducedMotion: 'reduce' });
  const results = [];
  try {
    await signIn(page, origin);
    for (const palette of ['default', 'fresh']) {
      await page.goto(origin + '/?theme=' + palette);
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        results.push(
          await attempt(`theme roles ${palette} ${scheme}`, () =>
            page.evaluate((scheme) => {
              const { samples } = window.readTheme(scheme);
              const report = window.checkTheme(scheme);
              return {
                pass:
                  report.pass && !report.skipped.length && samples.length === 6,
                failures: report.failures.map((f) => [
                  f.variant,
                  f.pair,
                  f.state,
                  f.backdrop,
                  f.foreground.colour,
                  f.surface.colour,
                  f.ratio,
                ]),
              };
            }, scheme),
          ),
        );
        for (const actions of ['solid', 'inverted'])
          for (const secondary of ['tonal', 'outline', 'text']) {
            results.push(
              await attempt(
                `sdk-action-parity ${palette}/${actions}/${secondary} ${scheme}`,
                async () => {
                  await page.goto(
                    `${origin}/?theme=${palette}&actions=${actions}&secondary=${secondary}`,
                  );
                  await page.locator('.zen-title').waitFor();
                  const expected = await page.evaluate((scheme) => {
                    const { samples, active } = window.readTheme(scheme);
                    return samples.find(
                      (s) =>
                        s.scheme === scheme &&
                        s.variant.actions === active.actions &&
                        s.variant.secondary === active.secondary,
                    ).colours;
                  }, scheme);
                  const mismatches = [];
                  const check = async (button, role, label) => {
                    await page.mouse.move(1, 1);
                    for (const hover of [false, true]) {
                      if (hover) await button.hover();
                      await settle(page);
                      const got = await button.evaluate((el) => {
                        const ctx = document
                          .createElement('canvas')
                          .getContext('2d', { willReadFrequently: true });
                        ctx.globalCompositeOperation = 'copy';
                        const hex = (css) => {
                          ctx.fillStyle = css;
                          ctx.fillRect(0, 0, 1, 1);
                          const pixel = ctx.getImageData(0, 0, 1, 1).data;
                          return (
                            '#' +
                            Array.from(
                              pixel.slice(0, pixel[3] === 255 ? 3 : 4),
                              (c) => c.toString(16).padStart(2, '0'),
                            ).join('')
                          );
                        };
                        const style = getComputedStyle(el);
                        return [
                          hex(style.backgroundColor),
                          hex(style.color),
                          hex(style.borderTopColor),
                          style.borderTopWidth,
                        ];
                      });
                      const want = [
                        expected[role + (hover ? '-hover' : '')],
                        expected[role + '-foreground'],
                        expected[role + '-border'],
                        role === 'action' ? '2px' : '1px',
                      ];
                      if (got.some((v, i) => v !== want[i]))
                        mismatches.push({ label, hover, got, want });
                    }
                  };
                  await check(
                    page.getByRole('button', { name: 'Complete', exact: true }),
                    'action',
                    'ActionButton primary',
                  );
                  await check(
                    page.getByRole('button', {
                      name: 'Not today',
                      exact: true,
                    }),
                    'action-secondary',
                    'ActionButton secondary',
                  );
                  await openTask(page);
                  const save = page.getByRole('button', {
                    name: 'Save',
                    exact: true,
                  });
                  await page
                    .getByLabel('Title', { exact: true })
                    .fill('Changed title');
                  await check(save, 'action', 'SDK primary');
                  await check(
                    page.getByRole('button', { name: 'Cancel', exact: true }),
                    'action-secondary',
                    'SDK secondary',
                  );
                  return { pass: !mismatches.length, mismatches };
                },
              ),
            );
          }
      }
    }
    await page.goto(origin + '/?theme=contrast-control');
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      results.push(
        await attempt(`built theme samples only ${scheme}`, () =>
          page.evaluate((scheme) => {
            const other = scheme === 'dark' ? 'light' : 'dark';
            const report = window.checkTheme();
            const mismatch = window.checkTheme(other);
            const skippedOther = ({ skipped }) =>
              skipped.length === 6 &&
              skipped.every(
                (s) =>
                  s.scheme === other &&
                  s.reason.includes(`prefers-color-scheme: ${other}`),
              );
            const failures = report.failures;
            const destructiveHover = failures.filter(
              (f) => f.pair === 'destructive action' && f.state === 'hover',
            );
            return {
              pass:
                skippedOther(report) &&
                skippedOther(mismatch) &&
                !mismatch.pass &&
                !mismatch.failures.length &&
                (scheme === 'light'
                  ? report.pass
                  : !report.pass &&
                    failures.every((f) => f.scheme === 'dark') &&
                    failures.some(
                      (f) =>
                        f.variant.secondary === 'text' &&
                        f.backdrop === 'background' &&
                        f.ratio === 1,
                    ) &&
                    destructiveHover.some((f) => f.backdrop === 'popover') &&
                    destructiveHover.every((f) => f.backdrop !== 'background')),
            };
          }, scheme),
        ),
      );
    }
    await page.goto(origin + '/');
    results.push(
      await attempt('forced scheme and attribute restoration', () =>
        page.evaluate(() => {
          const root = document.documentElement;
          root.style.setProperty('color-scheme', 'only dark', 'important');
          const original = root.outerHTML.split('>')[0];
          const result = window.checkTheme();
          const restored = root.outerHTML.split('>')[0] === original;
          return {
            pass:
              restored &&
              result.pass &&
              result.skipped.length === 6 &&
              result.skipped.every(
                (s) => s.scheme === 'light' && s.reason.includes('only'),
              ),
          };
        }),
      ),
    );
    await page.goto(origin + '/');
    results.push(
      await attempt('invalid role restores page', () =>
        page.evaluate(() => {
          const root = document.documentElement;
          root.dataset.actions = 'inverted';
          root.style.setProperty('--accent', 'not-a-colour', 'important');
          const original = root.outerHTML.split('>')[0];
          const children = root.childElementCount;
          try {
            window.checkTheme();
            return { pass: false };
          } catch (error) {
            return {
              pass:
                error.message.includes('accent') &&
                root.outerHTML.split('>')[0] === original &&
                root.childElementCount === children,
            };
          }
        }),
      ),
    );
    await page.goto(origin + '/');
    results.push(
      await attempt('implicit active combination', () =>
        page.evaluate(() => {
          const css = document.createElement('style');
          css.textContent =
            ':root:not([data-secondary]) { --action-secondary-foreground: transparent }';
          document.head.append(css);
          const report = window.checkTheme('dark');
          return {
            pass:
              !report.pass &&
              report.failures.length > 0 &&
              report.failures.every(
                (f) =>
                  f.active &&
                  f.variant.secondary === 'tonal' &&
                  f.foreground.override &&
                  f.ratio === 1,
              ),
          };
        }),
      ),
    );
    await page.goto(origin + '/');
    results.push(
      await attempt('context-dependent role', () =>
        page.evaluate(() => {
          document.documentElement.style.setProperty(
            '--action',
            'currentColor',
          );
          try {
            window.checkTheme();
            return { pass: false };
          } catch (error) {
            return { pass: error.message.includes('currentColor in action') };
          }
        }),
      ),
    );
    for (const [attribute, variant, role, pair] of [
      ['actions', 'solid', 'action-foreground', 'primary action text'],
      ['actions', 'inverted', 'action-foreground', 'primary action text'],
      [
        'secondary',
        'tonal',
        'action-secondary-foreground',
        'secondary action text',
      ],
      [
        'secondary',
        'outline',
        'action-secondary-border',
        'secondary action boundary',
      ],
      [
        'secondary',
        'text',
        'action-secondary-foreground',
        'secondary action text',
      ],
    ])
      results.push(
        await attempt('known failure ' + variant, async () => {
          await page.goto(origin + '/');
          return page.evaluate(
            ({ attribute, variant, role, pair }) => {
              const css = document.createElement('style');
              css.textContent = `:root[data-${attribute}="${variant}"] { --${role}: transparent }`;
              document.head.append(css);
              const result = window.checkTheme();
              return {
                pass:
                  !result.pass &&
                  result.failures.length > 0 &&
                  result.failures.every(
                    (f) =>
                      f.pair === pair &&
                      f.variant[attribute] === variant &&
                      f.foreground.role === role &&
                      f.foreground.override &&
                      f.adjust.includes(role) &&
                      f.ratio === 1,
                  ),
              };
            },
            { attribute, variant, role, pair },
          );
        }),
      );
  } finally {
    await context.close();
  }
  return results;
}

export const suites = {
  gate,
  roundtrip,
  interaction,
  integration,
  contrast,
  routing,
  theme,
};
