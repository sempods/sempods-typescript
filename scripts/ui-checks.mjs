/* global document, Element, Event, getComputedStyle, history, innerHeight, innerWidth, location, MutationObserver, performance, requestAnimationFrame, window */
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
  await page.getByLabel(/^(Pod address|Pod-Adresse)$/).fill(origin + '/alice');
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

// Checks take seconds and each Playwright action at most 10s; a check that
// never settles fails under its own name instead of holding the job until its
// timeout.
const CHECK_DEADLINE_MS = 120_000;

/** Runs one check; an exception is a failure with its first line as note. */
async function attempt(id, run, extra = {}) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`check did not settle in ${CHECK_DEADLINE_MS / 1000}s`),
        ),
      CHECK_DEADLINE_MS,
    );
  });
  try {
    return { id, ...extra, ...(await Promise.race([run(), deadline])) };
  } catch (error) {
    return {
      id,
      ...extra,
      pass: false,
      note: 'error: ' + error.message.split('\n')[0],
    };
  } finally {
    clearTimeout(timer);
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
 * halfway; the end state is what the checks assert. It looks only in
 * animation frames: WebKit applies a finished transition's end value in the
 * next one, and under load no frame may come for hundreds of milliseconds,
 * so a check between frames read the focus outline at its starting colour.
 */
async function settle(page) {
  await page
    .evaluate(
      () =>
        new Promise((done) => {
          setTimeout(done, 5000);
          const check = () =>
            document
              .getAnimations()
              .some(
                (a) =>
                  a.playState === 'running' &&
                  a.effect?.getTiming().iterations !== Infinity,
              )
              ? requestAnimationFrame(check)
              : done();
          requestAnimationFrame(check);
        }),
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
    // Pods & sharing from the menu (#230): once the menu's popup has gone,
    // closing management with Escape or with a press on Close returns the
    // focus to the menu button, which the frame passes as `focusTarget`.
    // The button keeps the keyboard's ring after Escape, also after a Tab
    // inside management, and has none after a pointer's Close (#232).
    async 'menu-access-focus'() {
      const menu = page.getByRole('button', { name: 'Menu', exact: true });
      const sheet = page.getByRole('dialog', { name: /Pods & sharing/ });
      const ring = async () => {
        await settle(page);
        return menu.evaluate((el) => ({
          focusVisible: el.hasAttribute('data-focus-visible'),
          outline:
            getComputedStyle(el).outlineStyle === 'none'
              ? 'none'
              : `${getComputedStyle(el).outlineWidth} ${getComputedStyle(el).outlineStyle}`,
        }));
      };
      const shown = (r) =>
        r.focusVisible && r.outline !== 'none' && !r.outline.startsWith('0px');
      const open = async (how) => {
        if (how === 'keyboard') {
          await menu.focus();
          await page.keyboard.press('Enter');
          await page.getByRole('menuitem', { name: 'View' }).waitFor();
          await focusItem(page, 'Pods & sharing');
          await page.keyboard.press('Enter');
        } else {
          await menu.click();
          await page.getByRole('menuitem', { name: 'Pods & sharing' }).click();
        }
        await sheet.waitFor();
        // The popup unmounts after its exit; only then close management.
        return gone(page.getByRole('menu'));
      };
      const keyboardMenuGone = await open('keyboard');
      await page.keyboard.press('Escape');
      const keyboardClosed = await hidden(sheet);
      const afterEscape = await focusUntil(page, /Menu/, focused);
      const escapeRing = await ring();
      const tabMenuGone = await open('keyboard');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Escape');
      const tabClosed = await hidden(sheet);
      const afterTabEscape = await focusUntil(page, /Menu/, focused);
      const tabEscapeRing = await ring();
      const pointerMenuGone = await open('pointer');
      await sheet.getByRole('button', { name: 'Close', exact: true }).click();
      const pointerClosed = await hidden(sheet);
      const afterClose = await focusUntil(page, /Menu/, focused);
      const closeRing = await ring();
      return {
        pass:
          keyboardMenuGone &&
          keyboardClosed &&
          /Menu/.test(afterEscape) &&
          shown(escapeRing) &&
          tabMenuGone &&
          tabClosed &&
          /Menu/.test(afterTabEscape) &&
          shown(tabEscapeRing) &&
          pointerMenuGone &&
          pointerClosed &&
          /Menu/.test(afterClose) &&
          !closeRing.focusVisible &&
          closeRing.outline === 'none',
        keyboardMenuGone,
        afterEscape,
        escapeRing,
        afterTabEscape,
        tabEscapeRing,
        pointerMenuGone,
        afterClose,
        closeRing,
      };
    },
    // A row's quiet menu (sempods-apps-template#145, #116, #141): a ghost
    // button with a 44px target and no fill until it is used; its Priority
    // choices are a section of the menu, not a submenu; the unavailable
    // Urgent stays visible, arrow keys skip it and a press neither chooses
    // it nor closes the menu; a choice closes the menu and stays checked;
    // Escape returns the focus to the row's button.
    async 'row-menu-section'() {
      await page.goto(origin + '/list');
      await page.locator('.gate-list a').first().waitFor();
      const row = page.getByRole('button', { name: /: more$/ }).first();
      const button = await row.evaluate((el) => {
        const s = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return {
          variant: el.dataset.variant,
          width: box.width,
          height: box.height,
          filled: !/^(rgba\(\d+, \d+, \d+, 0\)|transparent)$/.test(
            s.backgroundColor,
          ),
        };
      });
      await row.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menu').waitFor();
      const submenu = await page
        .getByRole('menuitem', { name: 'Priority' })
        .count();
      const group = await page
        .getByRole('group', { name: 'Priority' })
        .getByRole('menuitemradio')
        .count();
      const urgent = page.getByRole('menuitemradio', { name: 'Urgent' });
      const urgentDisabled = await urgent.getAttribute('aria-disabled');
      const visited = [await focused(page)];
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(100);
        visited.push(await focused(page));
      }
      const skipped = !visited.some((f) => /Urgent/.test(f));
      await urgent.click({ force: true });
      await settle(page);
      const openAfterPress = await page.getByRole('menu').isVisible();
      const urgentChecked = await urgent.getAttribute('aria-checked');
      // The press leaves the focus in the menu: an arrow key moves on to an
      // available choice or action.
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(150);
      const afterPress = await focused(page);
      await focusItem(page, 'High');
      const onHigh = await focused(page);
      await page.keyboard.press('Enter');
      const closed = await hidden(page.getByRole('menu'));
      const onRow = () => row.evaluate((el) => el === document.activeElement);
      await focusUntil(page, /button/, focused);
      const backOnRow = await onRow();
      await page.keyboard.press('Enter');
      await page.getByRole('menu').waitFor();
      const highChecked = await page
        .getByRole('menuitemradio', { name: 'High' })
        .getAttribute('aria-checked');
      await page.keyboard.press('Escape');
      const escaped = await hidden(page.getByRole('menu'));
      await focusUntil(page, /button/, focused);
      const afterEscape = await onRow();
      return {
        pass:
          button.variant === 'ghost' &&
          button.width >= 44 &&
          button.height >= 44 &&
          !button.filled &&
          submenu === 0 &&
          group === 3 &&
          urgentDisabled === 'true' &&
          skipped &&
          openAfterPress &&
          urgentChecked === 'false' &&
          /^menuitem/.test(afterPress) &&
          !/Urgent/.test(afterPress) &&
          closed &&
          backOnRow &&
          highChecked === 'true' &&
          escaped &&
          afterEscape,
        button,
        submenu,
        group,
        urgentDisabled,
        visited,
        openAfterPress,
        urgentChecked,
        afterPress,
        onHigh,
        closed,
        backOnRow,
        highChecked,
        afterEscape,
      };
    },
    // A decorative leading icon (#231): Pods & sharing keeps its label as
    // its whole name and leads typeahead; every row's label starts in one
    // column next to the 16px icon, and rows stay 44px high. Right to left
    // too: React Aria lays the menu out by the browser's locale (Arabic here).
    async 'menu-icon-columns'() {
      const measure = async (p) => {
        const menu = p.getByRole('button', { name: 'Menu', exact: true });
        await menu.focus();
        await p.keyboard.press('Enter');
        await p
          .getByRole('menuitem', { name: 'Pods & sharing', exact: true })
          .waitFor();
        await settle(p);
        const rows = await p.getByRole('menu').evaluate((list) =>
          [...list.querySelectorAll('[role=menuitem]')].map((item) => {
            const dir = getComputedStyle(item).direction;
            // Where the label's text starts, apart from any icon.
            const text = [...item.childNodes].find(
              (node) => node.nodeType === 3 && node.textContent.trim(),
            );
            const range = document.createRange();
            if (text) range.selectNodeContents(text);
            const box = text ? range.getBoundingClientRect() : null;
            const icon = item.querySelector('[aria-hidden=true] svg');
            return {
              label: text?.textContent.trim(),
              dir,
              start: box ? (dir === 'rtl' ? box.right : box.left) : null,
              height: item.getBoundingClientRect().height,
              icon: icon ? icon.getBoundingClientRect().width : null,
            };
          }),
        );
        const starts = rows.map((row) => row.start);
        const column =
          starts.every((start) => start !== null) &&
          Math.max(...starts) - Math.min(...starts) <= 0.5;
        return { column, rows };
      };
      const ltr = await measure(page);
      await page.keyboard.press('p');
      const typeahead = await focusUntil(page, /Pods & sharing/, focused);
      await page.keyboard.press('Escape');
      await hidden(page.getByRole('menu'));
      const arabic = await newPage(browser, { locale: 'ar-EG' });
      let rtl;
      try {
        await signIn(arabic.page, origin);
        rtl = await measure(arabic.page);
      } finally {
        await arabic.context.close();
      }
      const podsRow = ltr.rows.find((row) => row.label === 'Pods & sharing');
      return {
        pass:
          ltr.column &&
          ltr.rows.every((row) => row.dir === 'ltr' && row.height >= 44) &&
          rtl.column &&
          rtl.rows.every((row) => row.dir === 'rtl' && row.height >= 44) &&
          podsRow?.icon === 16 &&
          /Pods & sharing/.test(typeahead),
        ltr,
        rtl,
        typeahead,
      };
    },
    // #232: the menu's focus styles follow React Aria's input modality, in
    // light, dark and forced colors. A hovered row gets the accent surface
    // without a ring and turns neutral over the separator although it keeps
    // the focus; a pointer dismissal leaves no ring on the button; keyboard
    // focus draws one solid outline, inside the row in the menu and around
    // the button after Escape. Forced colors drop the surfaces: the focused
    // row draws the inner outline, also for the pointer, and other rows none.
    async 'menu-focus-modality'() {
      const menu = page.getByRole('button', { name: 'Menu', exact: true });
      const view = page.getByRole('menuitem', { name: 'View' });
      const sharing = page.getByRole('menuitem', { name: 'Pods & sharing' });
      const paint = (locator) =>
        locator.evaluate((el) => {
          const s = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          const scroller = el.closest('[role=menu]')?.getBoundingClientRect();
          const grow = Math.max(
            0,
            parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset),
          );
          return {
            focused: el === document.activeElement,
            outline:
              s.outlineStyle === 'none'
                ? 'none'
                : `${s.outlineWidth} ${s.outlineStyle} ${s.outlineOffset}`,
            // A visible shadow with a spread: Tailwind's ring.
            ring: [
              ...s.boxShadow.matchAll(
                /((?:rgba?|oklch|oklab|color|lab|lch)\([^)]*\)|#[0-9a-f]+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/g,
              ),
            ].some(
              (m) =>
                parseFloat(m[5]) > 0 &&
                !/^rgba\(.*,\s*0\)$|\/\s*0\)$/.test(m[1]),
            ),
            filled: !/^(rgba\(\d+, \d+, \d+, 0\)|transparent)$/.test(
              s.backgroundColor,
            ),
            inside:
              !scroller ||
              (box.left - grow >= scroller.left - 0.5 &&
                box.right + grow <= scroller.right + 0.5 &&
                box.top - grow >= scroller.top - 0.5 &&
                box.bottom + grow <= scroller.bottom + 0.5),
          };
        });
      const inner = '2px solid -2px';
      const modes = {};
      for (const [mode, media] of Object.entries({
        light: { colorScheme: 'light', forcedColors: 'none' },
        dark: { colorScheme: 'dark', forcedColors: 'none' },
        forced: { colorScheme: 'light', forcedColors: 'active' },
      })) {
        await page.emulateMedia(media);
        const forced = media.forcedColors === 'active';
        await page.mouse.move(8, 400);
        await menu.click();
        await sharing.waitFor();
        const row = await sharing.boundingBox();
        const x = row.x + row.width / 2;
        await page.mouse.move(x, row.y + row.height / 2, { steps: 5 });
        await settle(page);
        const hovered = await paint(sharing);
        const separator = await page
          .locator('[data-slot=dropdown-menu-separator]')
          .boundingBox();
        await page.mouse.move(x, separator.y + separator.height / 2, {
          steps: 8,
        });
        await settle(page);
        const overSeparator = await paint(sharing);
        await page.mouse.click(8, 400);
        await hidden(page.getByRole('menu'));
        await settle(page);
        const afterPointer = await paint(menu);
        // Enter focuses View (a submenu trigger), ArrowDown a plain row.
        await page.keyboard.press('Enter');
        await view.waitFor();
        await settle(page);
        const keyboardSubTrigger = await paint(view);
        await page.keyboard.press('ArrowDown');
        await settle(page);
        const keyboardRow = await paint(sharing);
        const otherRow = await paint(view);
        await page.keyboard.press('Escape');
        await hidden(page.getByRole('menu'));
        await settle(page);
        const afterEscape = await paint(menu);
        const pass =
          (forced
            ? hovered.outline === inner &&
              overSeparator.focused &&
              overSeparator.outline === inner &&
              otherRow.outline === 'none'
            : hovered.filled &&
              hovered.outline === 'none' &&
              overSeparator.outline === 'none' &&
              !overSeparator.filled &&
              keyboardSubTrigger.filled &&
              keyboardRow.filled &&
              !otherRow.filled &&
              otherRow.outline === 'none') &&
          afterPointer.focused &&
          afterPointer.outline === 'none' &&
          !afterPointer.ring &&
          keyboardSubTrigger.outline === inner &&
          keyboardSubTrigger.inside &&
          keyboardRow.focused &&
          keyboardRow.outline === inner &&
          keyboardRow.inside &&
          afterEscape.focused &&
          afterEscape.outline === '2px solid 2px' &&
          !afterEscape.ring;
        modes[mode] = {
          pass,
          hovered,
          overSeparator,
          afterPointer,
          keyboardSubTrigger,
          keyboardRow,
          otherRow,
          afterEscape,
        };
      }
      await page.emulateMedia({ colorScheme: null, forcedColors: null });
      return {
        pass: Object.values(modes).every((m) => m.pass),
        ...modes,
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
    // Filter chips at 375px: Tab reaches the group on the chosen chip, an
    // arrow moves, Space chooses, Tab leaves the group. A chosen chip is
    // filled with the primary role and marked; chips are 44px high and the
    // page does not overflow.
    async 'chips-keyboard'() {
      await page.setViewportSize({ width: 375, height: 812 });
      try {
        await page.goto(origin + '/list');
        await page.locator('.gate-list a').first().waitFor();
        const open = page.getByRole('radio', { name: 'Open', exact: true });
        const all = page.getByRole('radio', { name: 'All', exact: true });
        const isFocused = (chip) =>
          chip.evaluate((el) => el === document.activeElement);
        await page.getByRole('button', { name: 'Menu', exact: true }).focus();
        for (let i = 0; i < 8 && !(await isFocused(open)); i++)
          await page.keyboard.press(tab);
        const onOpen = await isFocused(open);
        await page.keyboard.press('ArrowRight');
        const onAll = await isFocused(all);
        await page.keyboard.press('Space');
        await settle(page);
        const chosen = await all.getAttribute('aria-checked');
        await page.keyboard.press(tab);
        const left = await page.evaluate(
          () => document.activeElement?.closest('.gate-list') !== null,
        );
        const chips = await page.evaluate(() => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--primary)';
          document.body.append(probe);
          const primary = getComputedStyle(probe).color;
          probe.remove();
          return [
            ...document.querySelectorAll('[data-slot=toggle-group-item]'),
          ].map((chip) => ({
            height: chip.getBoundingClientRect().height,
            selected: chip.getAttribute('aria-checked') === 'true',
            marked: chip.querySelector('svg') !== null,
            filled: getComputedStyle(chip).backgroundColor === primary,
          }));
        });
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        );
        return {
          pass:
            onOpen &&
            onAll &&
            chosen === 'true' &&
            left &&
            chips.length === 2 &&
            chips.every(
              (c) =>
                c.height >= 44 &&
                c.marked === c.selected &&
                c.filled === c.selected,
            ) &&
            !overflow,
          onOpen,
          onAll,
          chosen,
          left,
          chips,
          overflow,
        };
      } finally {
        await page.setViewportSize({ width: 1280, height: 800 });
      }
    },
    // The Zen actions' group: the dock's full width at 375px, at most 26rem
    // and centred at 1280px; the labelled action takes the free width, the
    // round ones keep theirs, none overlap and each is its own Tab stop.
    async 'action-group-width'() {
      const measure = async (width) => {
        await page.setViewportSize({ width, height: width < 600 ? 812 : 800 });
        await page.goto(origin + '/');
        const group = page.getByRole('group', { name: 'Task actions' });
        await group.waitFor();
        await settle(page);
        return group.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const parent = el.parentElement.getBoundingClientRect();
          return {
            width: box.width,
            parent: parent.width,
            centred:
              Math.abs(box.left - parent.left - (parent.right - box.right)) < 1,
            actions: [...el.children].map((child) => {
              const r = child.getBoundingClientRect();
              return {
                shape: child.dataset.shape,
                tabIndex: child.tabIndex,
                left: r.left,
                right: r.right,
                width: r.width,
                height: r.height,
              };
            }),
          };
        });
      };
      try {
        const phone = await measure(375);
        const desktop = await measure(1280);
        const fits = ({ actions }) => {
          const round = actions.find((a) => a.shape === 'round');
          return (
            actions.length === 3 &&
            actions.every(
              (a, i) =>
                a.height >= 44 &&
                a.tabIndex === 0 &&
                (i === 0 || a.left >= actions[i - 1].right),
            ) &&
            actions
              .filter((a) => a.shape === 'pill')
              .every((a) => a.width > round.width)
          );
        };
        return {
          pass:
            Math.abs(phone.width - phone.parent) < 1 &&
            desktop.width <= 416.5 &&
            desktop.width < desktop.parent &&
            desktop.centred &&
            fits(phone) &&
            fits(desktop),
          phone,
          desktop,
        };
      } finally {
        await page.setViewportSize({ width: 1280, height: 800 });
      }
    },
    // sempods-apps-template#115: at 375px on a page taller than the screen,
    // with a scrollbar that takes width, the routed screen and the SDK's
    // Pods & sharing sheet stay inside the visible width, their Close
    // buttons included. Engines that draw overlay scrollbars skip it.
    async 'dialogs-with-page-scrollbar'() {
      const { context: tall, page: p } = await newPage(browser, {
        viewport: { width: 375, height: 812 },
      });
      try {
        await tall.addInitScript(() =>
          document.addEventListener('DOMContentLoaded', () => {
            const style = document.createElement('style');
            style.textContent =
              '::-webkit-scrollbar { width: 15px } ::-webkit-scrollbar-thumb { background: #888 }';
            document.head.append(style);
            const spacer = document.createElement('div');
            spacer.style.height = '300vh';
            document.body.append(spacer);
          }),
        );
        await signIn(p, origin, '/list');
        const gutter = await p.evaluate(
          () => innerWidth - document.documentElement.clientWidth,
        );
        if (gutter <= 0)
          return { pass: false, skip: 'no scrollbar that takes width' };
        const inside = (dialog) =>
          dialog.evaluate((el) => {
            const visible = document.documentElement.clientWidth;
            const box = el.getBoundingClientRect();
            const close = [...el.querySelectorAll('button')]
              .find((b) =>
                /^(Close|Schließen)$/.test(
                  b.ariaLabel ?? b.textContent?.trim() ?? '',
                ),
              )
              ?.getBoundingClientRect();
            return {
              visible,
              left: box.left,
              right: box.right,
              closeRight: close?.right ?? null,
              pass:
                box.left >= -0.5 &&
                box.right <= visible + 0.5 &&
                close !== undefined &&
                close.right <= visible + 0.5,
            };
          });
        await p.getByRole('button', { name: 'Menu', exact: true }).click();
        await p.getByRole('menuitem', { name: 'Pods & sharing' }).click();
        const sheetDialog = p.getByRole('dialog', { name: /Pods & sharing/ });
        await sheetDialog.waitFor();
        await settle(p);
        const sheet = await inside(sheetDialog);
        await p.keyboard.press('Escape');
        await hidden(sheetDialog);
        await p.goto(origin + '/tasks/add');
        const screenDialog = p.getByRole('dialog', { name: 'New task' });
        await screenDialog.waitFor();
        await settle(p);
        const screen = await inside(screenDialog);
        return { pass: sheet.pass && screen.pass, gutter, sheet, screen };
      } finally {
        await tall.close();
      }
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
  // A borderless field framed by its wrapper (an input group, the SDK's Pod
  // address) is bounded by the wrapper's border; a divider is no frame.
  [
    'boundary-wrapper-low',
    false,
    'field-boundary',
    '<div style="border:1px solid #eee"><input aria-label="fx" style="border:0;color:#000" value="x"></div>',
  ],
  [
    'boundary-wrapper-readable',
    true,
    'field-boundary',
    '<div style="border:1px solid #767676"><input aria-label="fx" style="border:0;color:#000" value="x"></div>',
  ],
  [
    'boundary-wrapper-top-only',
    false,
    'field-boundary',
    '<div style="border-top:1px solid #767676"><input aria-label="fx" style="border:0;color:#000" value="x"></div>',
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
  // The List view with its filter chips, "Open" chosen.
  async list(page) {
    await states.menu(page);
    await page.getByRole('menuitemradio', { name: 'List' }).click();
    await page.getByRole('radio', { name: 'Open', exact: true }).waitFor();
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
  // The README's views as links, Zen the current one (#343).
  async tabs(page) {
    await page.getByRole('link', { name: 'Zen', exact: true }).waitFor();
  },
};
/** The query that loads a state's own page, after the theme's. */
const stateScreens = { tabs: '&screen=tabs' };
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
 * state × palette and variants × light and dark × 375 and 1280px. Zen actions,
 * the unchosen filter chip and both view links are also measured hovered and
 * pressed; controls reached by Tab with their focus indicator. A measurement of these states, not a full audit.
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
      await settle(page);
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
              await page.goto(
                origin + '/' + query + (stateScreens[state] ?? ''),
              );
              await reach(page);
              await settle(page);
              const measured = await page.evaluate(() => window.uiContrast());
              const tagged = (list, suffix) =>
                list.map((m) => ({ ...m, what: `${m.what} ${suffix}` }));
              const pressed = {
                zen: ['Complete', 'Not today', 'Previous task'],
                list: ['All'],
                tabs: ['Zen', 'List'],
              };
              const role = { list: 'radio', tabs: 'link' }[state] ?? 'button';
              for (const name of pressed[state] ?? []) {
                const target = page.getByRole(role, { name, exact: true });
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
  // An address that names its source opens without a Context choice. Not
  // found covers the page: its Context choice waits, inert, behind it.
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
    [
      'invalid-legacy-signed-out',
      '/?task=!!!',
      { notFound: /not valid/, choose: false, behind: true },
    ],
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
        let asked = false;
        let behind = true;
        if (expected.behind) {
          await chooser(page).waitFor();
          behind = await chooser(page).evaluate(
            (el) => el.closest('[inert]') !== null,
          );
        } else asked = !choose && (await chooser(page).isVisible());
        const path = addressOf(page);
        return {
          pass:
            path === address &&
            shows &&
            !asked &&
            behind &&
            errors.length === 0,
          path,
          chooserShown: asked,
          chooserBehind: behind,
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

/**
 * The README's quick edit (#229): a compact `Dialog` around an SDK editor.
 * Cancelling an SDK question above it keeps the dialog and the draft, its
 * corner Close asks through the editor, and it speaks the SDK's language.
 * Its corner Close is a 44px target with the package's stylesheet alone (#288).
 */
async function compact({ browser, origin, engine }) {
  const { context, page, errors } = await newPage(browser);
  await signIn(page, origin);
  const dialog = page.getByRole('dialog', { name: /^(Rename|Umbenennen)$/ });
  const confirm = page.getByRole('alertdialog');
  const title = dialog.getByLabel(/^(Title|Titel)$/);
  const open = async (lang = 'en') => {
    await page.goto(
      origin + `/?dialog=compact${lang === 'de' ? '&lang=de' : ''}`,
    );
    await page.locator('.zen-title').click();
    await title.waitFor();
    await settle(page);
  };
  const state = async () => {
    await settle(page);
    const dialogOpen = await dialog.isVisible();
    return {
      dialogOpen,
      confirmOpen: await confirm.isVisible(),
      draftKept: dialogOpen ? await editKept(title) : false,
      focus: await focusInfo(page),
    };
  };
  const close = () =>
    dialog.getByRole('button', { name: 'Close', exact: true }).click();
  // The narrow field scrolls its text: a click lands inside it, and WebKit on
  // macOS ignores End there, so the caret goes to the end first.
  const dirty = async () => {
    await title.click();
    await title.evaluate((el) =>
      el.setSelectionRange(el.value.length, el.value.length),
    );
    await page.keyboard.type(EDIT);
  };
  const titles = async () =>
    (await storedTasks(origin)).map(
      (t) => t.body['https://schema.org/name']?.[0]?.['@value'],
    );
  const checks = {
    // Close, then Cancel by pointer: the press in the question is no press
    // beside the dialog.
    async 'compact-close-cancel'() {
      await open();
      await dirty();
      await close();
      const asked = await shown(confirm, 3000);
      await confirm.getByRole('button').first().click();
      await hidden(confirm);
      const s = await state();
      return {
        pass: asked && s.dialogOpen && s.draftKept && !s.confirmOpen,
        asked,
        ...s,
      };
    },
    // Escape in the question answers only the question.
    async 'compact-close-escape'() {
      await open();
      await dirty();
      await close();
      const asked = await shown(confirm, 3000);
      await page.keyboard.press('Escape');
      await hidden(confirm);
      const s = await state();
      return {
        pass: asked && s.dialogOpen && s.draftKept && !s.confirmOpen,
        asked,
        ...s,
      };
    },
    // The editor's own delete question, cancelled by pointer.
    async 'compact-delete-cancel'() {
      await open();
      const before = (await titles()).length;
      await dirty();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      const asked = await shown(confirm, 3000);
      await confirm.getByRole('button').first().click();
      await hidden(confirm);
      const s = await state();
      const kept = (await titles()).length === before;
      return {
        pass: asked && s.dialogOpen && s.draftKept && !s.confirmOpen && kept,
        asked,
        taskKept: kept,
        ...s,
      };
    },
    // A press beside the dialog asks too; discarding closes it unsaved.
    async 'compact-outside-discard'() {
      await open();
      await dirty();
      await page.mouse.click(5, 5);
      const asked = await answerLeave(page, 'discard');
      const closed = await gone(dialog);
      const unsaved = !(await titles()).some((t) => t?.endsWith(EDIT));
      return { pass: asked && closed && unsaved, asked, closed, unsaved };
    },
    // A source Context the app cannot read: its problem, no editor and no
    // loading notice that stays.
    async 'compact-source-unavailable'() {
      const { at } = plumberTask(origin);
      const nope = encodeURIComponent(origin + '/alice/_system/contexts/nope');
      await page.goto(origin + `${at}?context=${nope}&dialog=compact`);
      const alert = await shown(dialog.getByRole('alert'));
      const text = await dialog.getByRole('alert').textContent();
      const editors = await title.count();
      return {
        pass: alert && /not available/.test(text ?? '') && editors === 0,
        text,
        editors,
      };
    },
    // German: the corner Close takes the SDK's text. Counted, not read:
    // Firefox 159 with Playwright 1.65 crashes the page on evaluateAll() or
    // allTextContents() of a locator chained to getByRole() (#264).
    async 'compact-close-label-german'() {
      await open('de');
      const closes = dialog.locator('[data-slot=dialog-close]');
      const count = await closes.count();
      const german = await closes
        .and(dialog.getByRole('button', { name: 'Schließen', exact: true }))
        .count();
      return { pass: count === 1 && german === 1, count, german };
    },
    // The corner Close is a 44px target around a compact glyph (#288), with
    // the stylesheet the README documents and no app CSS: inside the dialog
    // and clear of its title and fields, at 375px and on the desktop, light
    // and dark. A press anywhere in the target closes the dialog, and the
    // keyboard reaches and presses it.
    async 'compact-close-target'() {
      const tab = tabKey(engine);
      const corner = dialog.locator(':scope > [data-slot=dialog-close]');
      const cases = [];
      try {
        for (const width of [375, 1280])
          for (const scheme of ['light', 'dark']) {
            const height = width === 375 ? 812 : 800;
            await page.setViewportSize({ width, height });
            await page.emulateMedia({ colorScheme: scheme });
            await open();
            const m = await dialog.evaluate((el) => {
              const close = el.querySelector(
                ':scope > [data-slot=dialog-close]',
              );
              const box = close.getBoundingClientRect();
              const glyph = close.querySelector('svg').getBoundingClientRect();
              const content = el.closest('[data-slot=dialog-content]');
              const frame = content.getBoundingClientRect();
              // Only what a child shows counts: a header's padding may lie
              // under the target.
              const shown = (node) => {
                const r = node.getBoundingClientRect();
                const pad = getComputedStyle(node);
                return {
                  top: r.top,
                  bottom: r.bottom,
                  left: r.left + parseFloat(pad.paddingLeft),
                  right: r.right - parseFloat(pad.paddingRight),
                };
              };
              const clear = [...el.children]
                .filter((child) => child !== close)
                .every((child) => {
                  const r = shown(child);
                  return (
                    r.right <= box.left ||
                    r.left >= box.right ||
                    r.bottom <= box.top ||
                    r.top >= box.bottom
                  );
                });
              // Rounded corners take no press: the middle of each edge does.
              const x = (box.left + box.right) / 2;
              const y = (box.top + box.bottom) / 2;
              const hits = [
                [box.left + 2, y],
                [box.right - 2, y],
                [x, box.top + 2],
                [x, box.bottom - 2],
              ].every(([px, py]) =>
                close.contains(document.elementFromPoint(px, py)),
              );
              return {
                target: [box.width, box.height],
                glyph: Math.max(glyph.width, glyph.height),
                inside:
                  box.top >= frame.top &&
                  box.right <= frame.right &&
                  frame.left >= 16 &&
                  frame.right <= innerWidth - 16 &&
                  frame.top >= 0 &&
                  frame.bottom <= innerHeight,
                clear,
                hits,
                colour: getComputedStyle(close).color,
                surface: getComputedStyle(content).backgroundColor,
                // A point in the target outside the registry's 28px box.
                rim: { x: box.left + 2, y },
              };
            });
            const { rim, ...measured } = m;
            await page.mouse.click(rim.x, rim.y);
            const pointer = await gone(dialog);
            await open();
            await title.focus();
            let reached = false;
            for (let i = 0; i < 8 && !reached; i++) {
              await page.keyboard.press(tab);
              reached = await corner.evaluate(
                (b) => document.activeElement === b,
              );
            }
            const ring = reached
              ? await corner.getAttribute('data-focus-visible')
              : null;
            if (reached) await page.keyboard.press('Enter');
            const keyboard = reached && (await gone(dialog));
            cases.push({
              width,
              scheme,
              ...measured,
              pointer,
              keyboard,
              ring: ring !== null,
            });
          }
      } finally {
        await page.emulateMedia({ colorScheme: null });
      }
      const surfaces = (width) =>
        new Set(cases.filter((c) => c.width === width).map((c) => c.surface))
          .size === 2;
      return {
        pass:
          cases.length === 4 &&
          cases.every(
            (c) =>
              Math.min(...c.target) >= 44 &&
              c.glyph <= 16 &&
              c.inside &&
              c.clear &&
              c.hits &&
              c.colour !== c.surface &&
              c.pointer &&
              c.keyboard &&
              c.ring,
          ) &&
          surfaces(375) &&
          surfaces(1280),
        cases,
      };
    },
  };
  const results = [];
  for (const [id, run] of Object.entries(checks)) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await fetch(origin + '/__reset');
    results.push(await attemptOn(errors, id, run));
  }
  results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
  await context.close();
  return results;
}

/**
 * ScreenDialog full screen on a phone with device insets (#228): Close below
 * the top inset, the heading and fields beside the side insets, the last
 * action above the bottom inset; the ordinary phone layout and the centred
 * dialog stay as they are. Only Chromium can emulate insets (DevTools
 * protocol); the other engines check the layout without them.
 */
async function insets({ browser, origin, engine }) {
  const { context, page, errors } = await newPage(browser);
  await signIn(page, origin);
  const cdp =
    engine === 'chromium' ? await context.newCDPSession(page) : undefined;
  const setInsets = (insets = {}) =>
    cdp?.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: 0, bottom: 0, left: 0, right: 0, ...insets },
    });
  const dialog = page.getByRole('dialog', { name: 'Details' });
  /** Opens the task at a size and measures the dialog's parts. */
  const measure = async (width, height, deviceInsets) => {
    await setInsets(deviceInsets);
    await page.setViewportSize({ width, height });
    await page.goto(origin + '/');
    await openTask(page);
    return dialog.evaluate((el) => {
      const box = (node) => {
        const r = node.getBoundingClientRect();
        return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
      };
      const [header, scroller] = el.children;
      const close = [...header.querySelectorAll('button')].at(-1);
      const field = scroller.querySelector('input');
      scroller.scrollTop = scroller.scrollHeight;
      const last = [...scroller.querySelectorAll('button')].at(-1);
      const padding = (node) => {
        const s = getComputedStyle(node);
        return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft];
      };
      return {
        modal: box(el.parentElement),
        heading: box(header.querySelector('h2')),
        close: box(close),
        field: box(field),
        last: box(last),
        scrolls: scroller.scrollHeight > scroller.clientHeight,
        headerPadding: padding(header),
        contentPadding: padding(scroller),
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
  };
  /**
   * Opens the task at width × tall, types into its nth text field, shrinks
   * the viewport to width × short as a keyboard does and measures.
   */
  const keyboard = async (width, tall, short, nth) => {
    await setInsets();
    await page.setViewportSize({ width, height: tall });
    await page.goto(origin + '/');
    await openTask(page);
    const before = await dialog.evaluate((el) => {
      const r = el.parentElement.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width };
    });
    const field = dialog.getByRole('textbox').nth(nth);
    await field.click();
    await field.press('End');
    await page.keyboard.type(' draft');
    const draft = await field.inputValue();
    await page.setViewportSize({ width, height: short });
    await settle(page);
    // Chromium's own scroll is smooth: wait until it ends.
    await page.waitForTimeout(500);
    const m = await dialog.evaluate((el) => {
      const box = (node) => {
        const r = node.getBoundingClientRect();
        return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
      };
      /** Whether the element's centre is on screen and shows the element. */
      const shows = (node) => {
        const r = node.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return !!hit && (hit === node || node.contains(hit));
      };
      const focused = document.activeElement;
      const result = {
        modal: box(el.parentElement),
        focusInDialog: el.contains(focused),
        field: box(focused),
        fieldShown: shows(focused),
        viewport: { width: innerWidth, height: innerHeight },
      };
      const last = [...el.querySelectorAll('button')].at(-1);
      for (let node = last.parentElement; node; node = node.parentElement)
        if (node.scrollHeight > node.clientHeight) {
          node.scrollTop = node.scrollHeight;
          break;
        }
      result.last = box(last);
      result.lastShown = shows(last);
      return result;
    });
    return {
      pass:
        before.top === 0 &&
        before.left === 0 &&
        before.width === width &&
        m.modal.top === 0 &&
        m.modal.bottom === m.viewport.height &&
        m.focusInDialog &&
        m.fieldShown &&
        m.lastShown &&
        (await field.inputValue()) === draft &&
        draft.endsWith(' draft'),
      before,
      ...m,
    };
  };
  const emulated = (run) => async () =>
    cdp ? run() : { pass: false, skip: 'no safe-area emulation' };
  const checks = {
    // Without insets the phone layout keeps its ordinary padding.
    async 'screen-dialog-phone-without-insets'() {
      const m = await measure(375, 600);
      return {
        pass:
          m.headerPadding.join() === '8px,16px,8px,16px' &&
          m.contentPadding.join() === '16px,16px,16px,16px' &&
          m.modal.top === 0 &&
          m.modal.left === 0,
        ...m,
      };
    },
    // A notch and a home indicator: Close and the last action stay clear.
    'screen-dialog-portrait-insets': emulated(async () => {
      const top = 47;
      const bottom = 34;
      // Low enough that the content scrolls to its last action.
      const m = await measure(375, 440, { top, bottom });
      return {
        pass:
          m.scrolls &&
          m.close.top >= top &&
          m.headerPadding[0] === `${8 + top}px` &&
          m.last.bottom <= m.viewport.height - bottom - 16 + 0.5 &&
          m.modal.top === 0,
        ...m,
      };
    }),
    // Landscape on a narrow phone: the heading, Close and the fields stay
    // beside the side insets.
    'screen-dialog-landscape-insets': emulated(async () => {
      const side = 44;
      const m = await measure(600, 360, {
        left: side,
        right: side,
        bottom: 21,
      });
      return {
        pass:
          m.heading.left >= side + 16 - 0.5 &&
          m.close.right <= m.viewport.width - side - 16 + 0.5 &&
          m.field.left >= side + 16 - 0.5 &&
          m.field.right <= m.viewport.width - side - 16 + 0.5 &&
          m.last.bottom <= m.viewport.height - 21 - 16 + 0.5,
        ...m,
      };
    }),
    // A keyboard opens while a field holds a draft (#314). With
    // interactive-widget=resizes-content the viewport shrinks, and Chromium
    // scrolls the focused field into view on its own, aligned with the top
    // of the viewport. Afterwards the dialog fills the viewport, the field
    // keeps its draft and the focus and is visible (not under the heading),
    // and the last action can be scrolled to.
    async 'screen-dialog-landscape-keyboard'() {
      // Pixel 8 in landscape: 915px wide, about 150px left by the keyboard.
      return keyboard(915, 340, 150, 0);
    },
    async 'screen-dialog-portrait-keyboard'() {
      return keyboard(375, 700, 260, 1);
    },
    // The centred dialog does not move with insets.
    'screen-dialog-centred-ignores-insets': emulated(async () => {
      const plain = await measure(1280, 800);
      const inset = await measure(1280, 800, {
        top: 47,
        bottom: 34,
        left: 44,
        right: 44,
      });
      return {
        pass:
          JSON.stringify(plain.modal) === JSON.stringify(inset.modal) &&
          plain.contentPadding.join() === inset.contentPadding.join() &&
          plain.headerPadding.join() === inset.headerPadding.join(),
        plain: plain.modal,
        inset: inset.modal,
      };
    }),
  };
  const results = [];
  for (const [id, run] of Object.entries(checks)) {
    await fetch(origin + '/__reset');
    results.push(await attemptOn(errors, id, run));
  }
  results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
  await context.close();
  return results;
}

/**
 * The README's workspace (`?workspace`): a canvas with a nonmodal filter
 * panel (WorkspacePanel, sempods-apps-template#143). The panel takes the
 * focus and gives it back, traps nothing, ignores presses beside it, sits
 * below SDK management and never resizes or remounts the canvas.
 */
async function workspace({ browser, origin, engine }) {
  const { context, page, errors } = await newPage(browser);
  await signIn(page, origin);
  const cdp =
    engine === 'chromium' ? await context.newCDPSession(page) : undefined;
  const toggle = page.getByRole('button', { name: /^(Filters|Filter)$/ });
  const panel = page.getByRole('region', { name: /^(Filters|Filter)$/ });
  const canvas = page.locator('canvas[aria-label=Graph]');
  const load = async (width = 1280, height = 800, query = '') => {
    await page.setViewportSize({ width, height });
    await page.goto(origin + '/?workspace' + query);
    await canvas.first().waitFor();
    await settle(page);
  };
  /** Opens the panel from its toggle by keyboard. */
  const openByKeyboard = async () => {
    await toggle.focus();
    await page.keyboard.press('Enter');
    await panel.waitFor();
    await settle(page);
  };
  const where = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      const region = document.querySelector(
        '[data-sempods-ui=workspace-panel]',
      );
      if (!el || el === document.body) return 'body';
      if (region && el === region) return 'panel';
      if (region?.contains(el)) return 'in-panel';
      return (
        el.tagName.toLowerCase() +
        (el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '')
      );
    });
  const box = (locator) =>
    locator.first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
    });
  const checks = {
    // Opening moves the focus into the named region; Escape inside closes
    // it and returns the focus to the toggle.
    async 'workspace-panel-focus-entry-escape'() {
      await load();
      await openByKeyboard();
      const entered = await where();
      await page.keyboard.press('Tab');
      const tabbed = await where();
      await page.keyboard.press('Escape');
      const closed = await hidden(panel);
      const back = await where();
      return {
        pass:
          entered === 'panel' &&
          tabbed === 'in-panel' &&
          closed &&
          /^button(Filters|Filter)$/.test(back),
        entered,
        tabbed,
        back,
      };
    },
    // Close by pointer returns the focus to the toggle as well.
    async 'workspace-panel-close-returns-focus'() {
      await load();
      await toggle.click();
      await panel.waitFor();
      await panel.getByRole('button', { name: 'Close', exact: true }).click();
      const closed = await hidden(panel);
      const back = await where();
      return {
        pass: closed && /^button(Filters|Filter)$/.test(back),
        back,
      };
    },
    // No focus trap: Tab and Shift+Tab leave the panel while it stays open.
    async 'workspace-panel-no-trap'() {
      await load();
      await openByKeyboard();
      const leave = async (key) => {
        await panel.focus();
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press(key);
          const at = await where();
          if (at !== 'panel' && at !== 'in-panel') return at;
        }
        return 'trapped';
      };
      // The page has a link after the panel (main.tsx), so Tab leaves the
      // panel into the page in every engine.
      const forward = await leave(tabKey(engine));
      const backward = await leave(
        engine === 'webkit' && process.platform === 'darwin'
          ? 'Alt+Shift+Tab'
          : 'Shift+Tab',
      );
      const open = await panel.isVisible();
      return {
        pass:
          /After the workspace/.test(forward) && backward !== 'trapped' && open,
        forward,
        backward,
      };
    },
    // A press on the canvas beside the panel reaches the canvas and keeps
    // the panel; Escape in the canvas is the canvas's.
    async 'workspace-panel-press-beside'() {
      await load();
      await toggle.click();
      await panel.waitFor();
      const p = await box(panel);
      const c = await box(canvas);
      const x = Math.round((p.right + c.right) / 2);
      const y = Math.round((c.top + c.bottom) / 2);
      const hit = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.tagName.toLowerCase(),
        [x, y],
      );
      await page.mouse.click(x, y);
      await canvas.first().focus();
      await page.keyboard.press('Escape');
      await settle(page);
      const open = await panel.isVisible();
      const focus = await where();
      return {
        pass: hit === 'canvas' && open && focus === 'canvasGraph',
        hit,
        open,
        focus,
      };
    },
    // Opening and closing keep the canvas element and its size, on desktop
    // and on a phone.
    async 'workspace-panel-canvas-kept'() {
      const runs = [];
      for (const [width, height] of [
        [1280, 800],
        [375, 667],
      ]) {
        await load(width, height);
        await canvas.first().evaluate((el) => (el.dataset.kept = 'yes'));
        const before = await box(canvas);
        await toggle.click();
        await panel.waitFor();
        await settle(page);
        const during = await box(canvas);
        await panel.getByRole('button', { name: 'Close', exact: true }).click();
        await hidden(panel);
        await settle(page);
        const after = await box(canvas);
        const kept = await page.evaluate(
          () =>
            document.querySelectorAll('canvas').length === 1 &&
            document.querySelector('canvas')?.dataset.kept === 'yes',
        );
        runs.push({
          width,
          kept,
          same:
            JSON.stringify(before) === JSON.stringify(during) &&
            JSON.stringify(before) === JSON.stringify(after),
          before,
          during,
        });
      }
      return { pass: runs.every((r) => r.kept && r.same), runs };
    },
    // Phones: the full width at the bottom, up to 70% of the height, with
    // the canvas visible above; its content scrolls when it is too long.
    async 'workspace-panel-phone-bounds'() {
      await load(375, 667);
      await toggle.click();
      await panel.waitFor();
      await settle(page);
      const tall = await box(panel);
      await page.setViewportSize({ width: 375, height: 160 });
      await settle(page);
      const low = await panel.evaluate((el) => {
        const [header, content] = el.children;
        const r = el.getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          headerTop: header.getBoundingClientRect().top,
          scrolls: content.scrollHeight > content.clientHeight,
          overflow: getComputedStyle(content).overflowY,
        };
      });
      return {
        pass:
          tall.left === 0 &&
          tall.right === 375 &&
          Math.abs(tall.bottom - 667) < 1 &&
          tall.top >= 667 * 0.3 - 1 &&
          low.top >= 160 * 0.3 - 1 &&
          low.headerTop >= 0 &&
          low.scrolls &&
          low.overflow === 'auto',
        tall,
        low,
      };
    },
    // SDK management opens above the panel and covers it; closing it
    // returns to the menu and leaves the panel open.
    async 'workspace-panel-below-management'() {
      await load();
      await toggle.click();
      await panel.waitFor();
      const menu = page.getByRole('button', { name: 'Menu', exact: true });
      const sheet = page.getByRole('dialog', { name: /Pods & sharing/ });
      await menu.click();
      await page.getByRole('menuitem', { name: 'Pods & sharing' }).click();
      await sheet.waitFor();
      await gone(page.getByRole('menu'));
      await settle(page);
      const p = await box(panel);
      const covered = await page.evaluate(
        ([x, y]) =>
          !document
            .querySelector('[data-sempods-ui=workspace-panel]')
            ?.contains(document.elementFromPoint(x, y)),
        [Math.round((p.left + p.right) / 2), Math.round(p.top + 20)],
      );
      await page.keyboard.press('Escape');
      const closed = await hidden(sheet);
      const focus = await focusUntil(page, /Menu/);
      const open = await panel.isVisible();
      return {
        pass: covered && closed && /Menu/.test(focus) && open,
        covered,
        focus,
        open,
      };
    },
    // German: the SDK's close text.
    async 'workspace-panel-german'() {
      await load(1280, 800, '&lang=de');
      await toggle.click();
      await panel.waitFor();
      const close = await panel
        .getByRole('button', { name: 'Schließen', exact: true })
        .count();
      return { pass: close === 1, close };
    },
    // Safe-area insets: the phone's content clears the home indicator, the
    // landscape panel clears the side cutout.
    'workspace-panel-insets': async () => {
      if (!cdp) return { pass: false, skip: 'no safe-area emulation' };
      const setInsets = (insets = {}) =>
        cdp.send('Emulation.setSafeAreaInsetsOverride', {
          insets: { top: 0, bottom: 0, left: 0, right: 0, ...insets },
        });
      try {
        await setInsets({ bottom: 34 });
        await load(375, 667);
        await toggle.click();
        await panel.waitFor();
        await settle(page);
        const phone = await panel.evaluate(
          (el) => getComputedStyle(el.children[1]).paddingBottom,
        );
        await setInsets({ left: 47, right: 47, bottom: 21 });
        await load(844, 390);
        await toggle.click();
        await panel.waitFor();
        await settle(page);
        const landscape = await box(panel);
        return {
          pass:
            phone === `${16 + 34}px` &&
            landscape.left >= 47 + 16 - 0.5 &&
            landscape.bottom <= 390 - 21 - 16 + 0.5,
          phone,
          landscape,
        };
      } finally {
        await setInsets();
      }
    },
    // Translucent where the browser blurs, solid with reduced transparency.
    'workspace-panel-reduced-transparency': async () => {
      if (!cdp)
        return {
          pass: false,
          skip: 'no prefers-reduced-transparency emulation',
        };
      const alpha = () =>
        panel.evaluate((el) => {
          const probe = document.createElement('canvas').getContext('2d');
          probe.fillStyle = getComputedStyle(el).backgroundColor;
          probe.fillRect(0, 0, 1, 1);
          return probe.getImageData(0, 0, 1, 1).data[3] / 255;
        });
      try {
        await load();
        await toggle.click();
        await panel.waitFor();
        await settle(page);
        const normal = await alpha();
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
        });
        await settle(page);
        const reduced = await alpha();
        return { pass: normal < 1 && reduced === 1, normal, reduced };
      } finally {
        await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      }
    },
  };
  const results = [];
  for (const [id, run] of Object.entries(checks))
    results.push(await attemptOn(errors, id, run));
  results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
  await context.close();
  return results;
}

/**
 * The search bar with suggestions (SuggestField) on `?screen=search`: its
 * keyboard, its states as announced and its layout. The checks set what the
 * app's search found through `window.searchGate`.
 */
async function search({ browser, origin }) {
  const { context, page, errors } = await newPage(browser);
  const field = page.getByRole('combobox', {
    name: /^(Address or search|Adresse oder Suche)$/,
  });
  const listbox = page.getByRole('listbox');
  const status = page.getByRole('status');
  const opened = page.getByRole('list', { name: 'Opened' });
  const suggestion = (id, label, source) => ({
    id: `https://pod.example/${id}`,
    label,
    detail: `https://pod.example/${id}`,
    ...(source ? { source } : {}),
  });
  const alice = suggestion('alice#me', 'Alice', 'Work');
  const bob = suggestion('bob#me', 'Bob');
  const carol = suggestion('carol#me', 'Carol', 'Home');
  const found = (state) =>
    page.evaluate((state) => window.searchGate(state), state);
  // The gate page sets `window.searchGate` in an effect, which WebKit can run
  // after the page has loaded and the field is shown.
  const gateReady = (on) =>
    on.waitForFunction(() => typeof window.searchGate === 'function');
  /** The announcement once it says `text`, or what it says after 3s. */
  const announced = async (text) => {
    await page
      .waitForFunction(
        (text) =>
          document.querySelector('[role="status"][data-live-announcer]')
            ?.textContent === text,
        text,
        { timeout: 3000 },
      )
      .catch(() => {});
    return status.textContent();
  };
  const open = async ({ width = 1280, lang = 'en', mode } = {}) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(
      origin +
        `/?screen=search${lang === 'de' ? '&lang=de' : ''}${
          mode ? `&mode=${mode}` : ''
        }`,
    );
    await field.waitFor();
    await gateReady(page);
  };
  /** The label of the suggestion the keyboard is on, if any. */
  const active = () =>
    field.evaluate((input) => {
      const id = input.getAttribute('aria-activedescendant');
      const option = id ? document.getElementById(id) : null;
      return option?.querySelector('[slot="label"]')?.textContent ?? null;
    });
  const focused = () =>
    page.evaluate(() => document.activeElement?.getAttribute('role') ?? null);
  const log = async () =>
    (await opened.getByRole('listitem').allTextContents()).map((t) => t.trim());
  /**
   * Records, until `heard`, how often a suggestion list is in the page and
   * what any live region says: the field's own and React Aria's announcer.
   */
  const listen = (on = page) =>
    on.evaluate(() => {
      const seen = { lists: 0, said: [] };
      const live = '[aria-live], [role="status"], [role="log"], [role="alert"]';
      const read = (records) => {
        if (document.querySelector('[role="listbox"]')) seen.lists++;
        for (const record of records) {
          const target =
            record.target instanceof Element
              ? record.target
              : record.target.parentElement;
          if (!target?.closest(live)) continue;
          const texts =
            record.type === 'characterData'
              ? [record.target.textContent]
              : [...record.addedNodes]
                  .filter((node) => node.isConnected)
                  .map((node) => node.textContent);
          for (const text of texts)
            if (text?.trim()) seen.said.push(text.trim());
        }
      };
      // What a region still holds once the task's microtasks have run, as
      // assistive technology reads it: SuggestField takes React Aria's
      // count out again when React Aria creates its announcer with it.
      const observer = new MutationObserver((records) =>
        window.queueMicrotask(() => read(records)),
      );
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      window.liveHeard = () => {
        read(observer.takeRecords());
        observer.disconnect();
        return seen;
      };
    });
  // React Aria's announcer speaks up to 100ms late the first time.
  const heard = async (on = page) => {
    await settle(on);
    await on.waitForTimeout(300);
    return on.evaluate(() => window.liveHeard());
  };
  /**
   * What every live region says while a search for "x" loads and `steps`
   * set its results, each once the field's status says its text, and then
   * as the keyboard moves to the first suggestion; on `on`, a page in the
   * browser locale of its own.
   */
  const searchHeard = async (on, lang, steps) => {
    await on.goto(origin + `/?screen=search${lang === 'de' ? '&lang=de' : ''}`);
    await gateReady(on);
    await on.evaluate(() => window.searchGate({ items: [], loading: true }));
    const input = on.getByRole('combobox');
    await input.click();
    await listen(on);
    await on.keyboard.type('x');
    for (const [state, text] of steps) {
      if (state) await on.evaluate((s) => window.searchGate(s), state);
      await on.waitForFunction(
        (text) =>
          document.querySelector('[role="status"][data-live-announcer]')
            ?.textContent === text,
        text,
        { timeout: 3000 },
      );
    }
    await on.keyboard.press('ArrowDown');
    const active = await input.evaluate((el) => {
      const id = el.getAttribute('aria-activedescendant');
      return id
        ? document.getElementById(id)?.querySelector('[slot="label"]')
            ?.textContent
        : null;
    });
    // React Aria says the active option itself on Apple devices.
    const apple = await on.evaluate(() =>
      /^(Mac|iPhone|iPad)/.test(window.navigator.platform),
    );
    return { active, apple, ...(await heard(on)) };
  };
  const checks = {
    // Typing opens the suggestions; arrows move, Enter chooses one and the
    // focus stays in the field.
    async 'search-arrow-enter-chooses'() {
      await open();
      await field.click();
      await page.keyboard.type('a');
      await found({ items: [alice, bob] });
      await listbox.waitFor();
      await page.keyboard.press('ArrowDown');
      const first = await active();
      await page.keyboard.press('ArrowDown');
      const second = await active();
      await page.keyboard.press('Enter');
      await hidden(listbox);
      const entries = await log();
      return {
        pass:
          first === 'Alice' &&
          second === 'Bob' &&
          entries.join() === 'select ' + bob.id &&
          (await focused()) === 'combobox',
        first,
        second,
        entries,
      };
    },
    // Enter with no suggestion active submits the typed address, while
    // suggestions show and without them.
    async 'search-enter-submits-text'() {
      await open();
      await field.click();
      await page.keyboard.type('https://pod.example/dan');
      await found({ items: [alice] });
      await listbox.waitFor();
      await page.keyboard.press('Enter');
      await hidden(listbox);
      await page.keyboard.press('End');
      await page.keyboard.type('#me');
      await found({ items: [] });
      await page.keyboard.press('Enter');
      const entries = await log();
      return {
        pass:
          entries.join() ===
          'submit https://pod.example/dan,submit https://pod.example/dan#me',
        entries,
      };
    },
    // Escape closes the suggestions and keeps the focus and the text in the
    // field.
    async 'search-escape-keeps-focus'() {
      await open();
      await field.click();
      await page.keyboard.type('bo');
      await found({ items: [bob] });
      await listbox.waitFor();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Escape');
      await hidden(listbox);
      const value = await field.inputValue();
      const entries = await log();
      return {
        pass:
          value === 'bo' &&
          (await focused()) === 'combobox' &&
          entries.length === 0,
        value,
        entries,
      };
    },
    // Results that arrive and reorder keep the suggestion the keyboard is
    // on.
    async 'search-reorder-keeps-active'() {
      await open();
      await field.click();
      await page.keyboard.type('o');
      await found({ items: [alice, bob], loading: true });
      await listbox.waitFor();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      const before = await active();
      await found({ items: [carol, bob, alice] });
      await listbox.getByRole('option').nth(2).waitFor();
      const after = await active();
      await page.keyboard.press('ArrowDown');
      const next = await active();
      return {
        pass: before === 'Bob' && after === 'Bob' && next === 'Alice',
        before,
        after,
        next,
      };
    },
    // Each state is announced, also while the suggestions hide the rest of
    // the page from assistive technology.
    async 'search-states-announced'() {
      await open();
      await field.click();
      await page.keyboard.type('x');
      const seen = {};
      await found({ items: [], loading: true });
      seen.loading = await announced('Searching …');
      seen.openWhileLoading = await listbox.isVisible();
      await found({ items: [] });
      seen.empty = await announced('No suggestions.');
      await found({ items: [alice], loading: true, failed: 'some' });
      seen.partial = await announced(
        '1 suggestion. Searching for more … Some sources could not be searched.',
      );
      await found({ items: [], failed: 'all' });
      seen.failed = await announced('The search failed.');
      await open({ lang: 'de' });
      await field.click();
      await page.keyboard.type('x');
      await found({ items: [], loading: true });
      seen.german = await announced('Suche läuft …');
      return {
        pass:
          seen.loading === 'Searching …' &&
          seen.openWhileLoading &&
          seen.empty === 'No suggestions.' &&
          seen.partial ===
            '1 suggestion. Searching for more … Some sources could not be searched.' &&
          seen.failed === 'The search failed.' &&
          seen.german === 'Suche läuft …',
        ...seen,
      };
    },
    // Only the field's status speaks about its suggestions, in every live
    // region, React Aria's announcer included, and in the provider's
    // language: a search still loading says that it searches, not "0
    // options available.", and each result once, without React Aria's
    // count beside it, also in a German browser. On Apple devices React
    // Aria still says the active suggestion, for VoiceOver (#326).
    async 'search-live-regions'() {
      const english = [
        [null, 'Searching …'],
        [
          { items: [alice], loading: true },
          '1 suggestion. Searching for more …',
        ],
        [{ items: [alice, bob] }, '2 suggestions.'],
        [{ items: [bob] }, '1 suggestion.'],
        [{ items: [] }, 'No suggestions.'],
        [{ items: [alice, carol] }, '2 suggestions.'],
      ];
      const en = await searchHeard(page, 'en', english);
      const de = await newPage(browser, { locale: 'de-DE' });
      const german = await searchHeard(de.page, 'de', [
        [null, 'Suche läuft …'],
        [{ items: [alice, bob] }, '2 Vorschläge.'],
      ]);
      await de.context.close();
      const expected = (texts, heard) =>
        [...texts, ...(heard.apple ? ['Alice'] : [])].join('|');
      return {
        pass:
          en.active === 'Alice' &&
          en.said.join('|') ===
            expected(
              english.map(([, text]) => text),
              en,
            ) &&
          german.active === 'Alice' &&
          german.said.join('|') ===
            expected(['Suche läuft …', '2 Vorschläge.'], german) &&
          de.errors.length === 0,
        en,
        german,
        errors: de.errors,
      };
    },
    // At 375px: 44px targets, labels on at most two lines, the exact address
    // on one cut-off line, nothing wider than the screen, one focus cue.
    async 'search-phone-layout'() {
      await open({ width: 375 });
      await field.click();
      await page.keyboard.type('a');
      const long = {
        ...suggestion(
          'a-very-long-resource-name-without-any-spaces-that-keeps-going#it',
          'A very long resource label that goes on and on across more than two lines on a phone screen of 375 pixels',
          'A Pod with a long name',
        ),
      };
      await found({ items: [long, bob] });
      await listbox.waitFor();
      await settle(page);
      const m = await page.evaluate(() => {
        const input = document.querySelector('[role="combobox"]');
        const group = input.closest('[data-slot="input-group"]');
        const options = [...document.querySelectorAll('[role="option"]')];
        const label = options[0].querySelector('[slot="label"]');
        const detail = options[0].querySelector('[slot="description"] span');
        const popover = document.querySelector(
          '[data-slot="combobox-content"]',
        );
        const lineHeight = parseFloat(getComputedStyle(label).lineHeight);
        return {
          input: group.getBoundingClientRect().height,
          options: options.map((o) => o.getBoundingClientRect().height),
          labelLines: Math.round(
            label.getBoundingClientRect().height / lineHeight,
          ),
          detailCut: detail.scrollWidth > detail.clientWidth,
          detailFull: detail.textContent,
          popoverRight: popover.getBoundingClientRect().right,
          pageWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
          inputOutline: getComputedStyle(input).outlineStyle,
          groupOutline: getComputedStyle(group).outlineStyle,
          groupRing: getComputedStyle(group).boxShadow,
        };
      });
      return {
        pass:
          m.input >= 44 &&
          m.options.every((h) => h >= 44) &&
          m.labelLines <= 2 &&
          m.detailCut &&
          m.detailFull.endsWith('keeps-going#it') &&
          m.popoverRight <= m.viewport &&
          m.pageWidth <= m.viewport &&
          m.inputOutline === 'none' &&
          m.groupOutline === 'solid',
        ...m,
      };
    },
    // A visual per suggestion (#361) at 375 and 1280px, light and dark: a
    // 40px box before the label, hidden from assistive technology, a photo
    // filling it and an icon centred in it; rows with a photo, an icon and
    // none line up; a long label still wraps to two lines, the exact
    // address stays on one, rows are 44px or more and nothing is wider
    // than the screen.
    async 'search-media-layout'() {
      const long = {
        ...suggestion(
          'a-very-long-resource-name-without-any-spaces-that-keeps-going#it',
          'A very long resource label that goes on and on across more than two lines on a phone screen of 375 pixels',
          'A Pod with a long name',
        ),
        picture: 'photo',
      };
      const cases = [];
      for (const width of [375, 1280])
        for (const scheme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme: scheme });
          await open({ width });
          await found({ items: [long, { ...bob, picture: 'icon' }, carol] });
          await field.click();
          await page.keyboard.type('a');
          await listbox.waitFor();
          await page.waitForFunction(() =>
            [...document.querySelectorAll('[role="option"] img')].every(
              (img) => img.complete && img.naturalWidth > 0,
            ),
          );
          await settle(page);
          const m = await page.evaluate(() => {
            const rect = (el) => el.getBoundingClientRect();
            const lines = (el) =>
              Math.round(
                rect(el).height / parseFloat(getComputedStyle(el).lineHeight),
              );
            const popover = document.querySelector(
              '[data-slot="combobox-content"]',
            );
            const rows = [...document.querySelectorAll('[role="option"]')].map(
              (o) => {
                const box = o.querySelector('[data-slot="suggestion-media"]');
                const label = o.querySelector('[slot="label"]');
                const detail = o.querySelector('[slot="description"] span');
                const img = box?.querySelector('img');
                const icon = box?.querySelector('svg');
                const centre = (r) => [
                  (r.left + r.right) / 2,
                  (r.top + r.bottom) / 2,
                ];
                return {
                  height: rect(o).height,
                  box: box
                    ? {
                        left: rect(box).left,
                        right: rect(box).right,
                        width: rect(box).width,
                        height: rect(box).height,
                        hidden: box.getAttribute('aria-hidden'),
                      }
                    : null,
                  labelLeft: rect(label).left,
                  labelLines: lines(label),
                  detailLines: detail ? lines(detail) : null,
                  detailCut: detail
                    ? detail.scrollWidth > detail.clientWidth
                    : null,
                  img: img
                    ? { width: rect(img).width, height: rect(img).height }
                    : null,
                  icon: icon
                    ? {
                        width: rect(icon).width,
                        offset: Math.max(
                          ...centre(rect(icon)).map((c, i) =>
                            Math.abs(c - centre(rect(box))[i]),
                          ),
                        ),
                      }
                    : null,
                };
              },
            );
            return {
              rows,
              popoverRight: rect(popover).right,
              pageWidth: document.documentElement.scrollWidth,
              viewport: innerWidth,
            };
          });
          const [first, second, third] = m.rows;
          const same = (values) =>
            values.every((v) => Math.abs(v - values[0]) < 0.5);
          const pass =
            m.rows.length === 3 &&
            m.rows.every(
              (r) =>
                r.height >= 44 &&
                r.box?.width === 40 &&
                r.box.height === 40 &&
                r.box.hidden === 'true' &&
                r.box.right <= r.labelLeft &&
                r.labelLines <= 2 &&
                (r.detailLines === null || r.detailLines === 1),
            ) &&
            same(m.rows.map((r) => r.box.left)) &&
            same(m.rows.map((r) => r.labelLeft)) &&
            (width > 375 || (first.labelLines === 2 && first.detailCut)) &&
            first.img?.width === 40 &&
            first.img.height === 40 &&
            second.icon?.width === 20 &&
            second.icon.offset < 1 &&
            third.img === null &&
            third.icon === null &&
            m.popoverRight <= m.viewport &&
            m.pageWidth <= m.viewport;
          cases.push({ width, scheme, pass, ...m });
        }
      await page.emulateMedia({ colorScheme: null });
      return { pass: cases.every((c) => c.pass), cases };
    },
    // With visuals, assistive technology reads the suggestions as without
    // them (#361): the same accessibility tree, names and descriptions, and
    // the field's announcements unchanged while results with visuals load
    // and arrive.
    async 'search-media-unheard'() {
      const pictured = [
        { ...alice, picture: 'photo' },
        { ...bob, picture: 'icon' },
        carol,
      ];
      await open();
      await field.click();
      await page.keyboard.type('a');
      const read = async (items) => {
        await found({ items });
        await listbox.getByRole('option').nth(2).waitFor();
        await settle(page);
        return {
          tree: await listbox.ariaSnapshot(),
          described: await listbox.evaluate((list) =>
            [...list.querySelectorAll('[role="option"]')].map((o) =>
              (o.getAttribute('aria-describedby') ?? '')
                .split(' ')
                .map((id) => document.getElementById(id)?.textContent ?? '')
                .join('|'),
            ),
          ),
        };
      };
      const plain = await read([alice, bob, carol]);
      const withMedia = await read(pictured);
      const media = await listbox
        .locator('[data-slot="suggestion-media"]')
        .count();
      const steps = [
        [null, 'Searching …'],
        [
          { items: pictured.slice(0, 1), loading: true },
          '1 suggestion. Searching for more …',
        ],
        [{ items: pictured }, '3 suggestions.'],
      ];
      const said = await searchHeard(page, 'en', steps);
      const expected = [
        ...steps.map(([, text]) => text),
        ...(said.apple ? ['Alice'] : []),
      ];
      return {
        pass:
          media === 3 &&
          withMedia.tree === plain.tree &&
          withMedia.described.join() === plain.described.join() &&
          said.active === 'Alice' &&
          said.said.join('|') === expected.join('|'),
        plain,
        withMedia,
        media,
        said,
      };
    },
    // The app's notice (#361) shows under the open suggestions, below the
    // field's own status line, both inside the popover's height while the
    // suggestions scroll, at 375px; it reaches no live region, and it goes
    // with the suggestions.
    async 'search-notice'() {
      const notice = 'Showing the first 30 results.';
      const many = Array.from({ length: 30 }, (_, i) =>
        suggestion(`r${i}`, `Result ${i + 1}`, 'Work'),
      );
      await open({ width: 375 });
      await found({ items: many, loading: true, notice });
      await field.click();
      await listen();
      await page.keyboard.type('a');
      await listbox.waitFor();
      const status = await announced('30 suggestions. Searching for more …');
      const heardNow = await heard();
      const m = await page.evaluate((notice) => {
        const rect = (el) => el.getBoundingClientRect();
        const popover = document.querySelector(
          '[data-slot="combobox-content"]',
        );
        const list = popover.querySelector('[role="listbox"]');
        const line = popover.querySelector('[data-slot="suggest-notice"]');
        const status = line?.previousElementSibling;
        return {
          text: line?.textContent,
          scrolls: list.scrollHeight > list.clientHeight,
          listBottom: rect(list).bottom,
          statusTop: status ? rect(status).top : null,
          statusBottom: status ? rect(status).bottom : null,
          lineTop: line ? rect(line).top : null,
          lineBottom: line ? rect(line).bottom : null,
          popoverBottom: rect(popover).bottom,
          live: !!line?.closest(
            '[aria-live], [role="status"], [role="log"], [role="alert"]',
          ),
          inLive: [
            ...document.querySelectorAll(
              '[aria-live], [role="status"], [role="log"], [role="alert"]',
            ),
          ].some((region) => region.textContent.includes(notice)),
        };
      }, notice);
      await page.keyboard.press('Escape');
      await hidden(listbox);
      const gone = await page.getByText(notice).count();
      return {
        pass:
          m.text === notice &&
          m.scrolls &&
          m.statusTop >= m.listBottom - 0.5 &&
          m.lineTop >= m.statusBottom - 0.5 &&
          m.lineBottom <= m.popoverBottom + 0.5 &&
          !m.live &&
          !m.inLive &&
          status === '30 suggestions. Searching for more …' &&
          heardNow.said.every((text) => !text.includes(notice)) &&
          heardNow.said.at(-1) === status &&
          gone === 0,
        ...m,
        status,
        said: heardNow.said,
        gone,
      };
    },
    // An address bar (#324): for an address and a single character the
    // field neither opens its suggestions nor announces a search, also on
    // the arrow keys; Enter submits and the first Escape reaches the panel.
    // A searchable text suggests in the same input, whose suggestions take
    // the first Escape again; Ctrl/Cmd-K focuses and selects it (`ref`).
    async 'search-address-mode'() {
      await open({ mode: 'address' });
      await listen();
      await field.click();
      await field.evaluate((input) => (window.addressInput = input));
      // The complete address arrives at once, as when it is pasted; its
      // prefixes, typed one by one, are searchable text.
      await page.keyboard.insertText('https://pod.example/dan');
      // Even a search result the app still holds stays unused.
      await found({ items: [] });
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      await settle(page);
      const expanded = await field.getAttribute('aria-expanded');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
      await field.fill('');
      await page.keyboard.type('d');
      await page.keyboard.press('ArrowDown');
      const quiet = await heard();
      const addressLog = await log();
      // Searchable text: the same input suggests again.
      await page.keyboard.type('a');
      await found({ items: [alice, carol] });
      await listbox.waitFor();
      const said = await announced('2 suggestions.');
      const same = await field.evaluate(
        (input) => input === window.addressInput,
      );
      await page.keyboard.press('Escape');
      await hidden(listbox);
      const afterFirst = await log();
      await page.keyboard.type('n');
      await listbox.waitFor();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      const chosen = await active();
      await page.keyboard.press('Enter');
      await hidden(listbox);
      await page.getByRole('heading', { name: 'Explorer' }).click();
      await page.keyboard.press('ControlOrMeta+k');
      const selected = await field.evaluate((input) => ({
        focused: document.activeElement === input,
        all:
          input.selectionStart === 0 &&
          input.selectionEnd === input.value.length,
        value: input.value,
      }));
      const entries = await log();
      return {
        pass:
          expanded === 'false' &&
          quiet.lists === 0 &&
          quiet.said.length === 0 &&
          addressLog.join() === 'close,submit https://pod.example/dan' &&
          said === '2 suggestions.' &&
          same &&
          afterFirst.length === 2 &&
          chosen === 'Carol' &&
          entries.at(-1) === 'select ' + carol.id &&
          selected.focused &&
          selected.all &&
          selected.value === 'dan',
        expanded,
        quiet,
        addressLog,
        said,
        same,
        afterFirst,
        chosen,
        selected,
        entries,
      };
    },
    // An address pasted over searched text closes the suggestions without
    // an announcement, also React Aria's count ("0 options available"); a
    // touch on the input's exact centre, which React Aria takes for an
    // iPad's virtual click, does not open them either (#324).
    async 'search-address-after-search'() {
      await open({ mode: 'address' });
      await field.click();
      await page.keyboard.type('da');
      await found({ items: [alice, carol] });
      await listbox.waitFor();
      await announced('2 suggestions.');
      // What React Aria says about the search itself has been said.
      await page.waitForTimeout(300);
      await listen();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.insertText('https://pod.example/dan');
      await hidden(listbox);
      const pasted = await heard();
      // React Aria ignores a touch within 500ms of the page's start.
      await page.waitForFunction(() => performance.now() > 600);
      await listen();
      await field.evaluate((input) => {
        const box = input.getBoundingClientRect();
        const event = new Event('touchend', {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, 'changedTouches', {
          value: [
            {
              identifier: 0,
              target: input,
              clientX: Math.ceil(box.left + box.width / 2),
              clientY: Math.ceil(box.top + box.height / 2),
            },
          ],
        });
        input.dispatchEvent(event);
      });
      const touched = await heard();
      const expanded = await field.getAttribute('aria-expanded');
      const focused = await field.evaluate(
        (input) => document.activeElement === input,
      );
      return {
        pass:
          pasted.said.length === 0 &&
          touched.lists === 0 &&
          touched.said.length === 0 &&
          expanded === 'false' &&
          focused,
        pasted,
        touched,
        expanded,
        focused,
      };
    },
    // A press chooses a suggestion too.
    async 'search-press-chooses'() {
      await open();
      await field.click();
      await page.keyboard.type('c');
      await found({ items: [alice, carol] });
      await listbox.getByRole('option', { name: /Carol/ }).click();
      await hidden(listbox);
      const entries = await log();
      return { pass: entries.join() === 'select ' + carol.id, entries };
    },
  };
  const results = [];
  for (const [id, run] of Object.entries(checks))
    results.push(await attemptOn(errors, id, run));
  results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
  await context.close();
  return results;
}

/**
 * Equal Context labels within one Pod (#290): each row names its quieter
 * qualifier, the trigger keeps the Pod beneath, at 320px in both schemes.
 */
async function contextQualifiers({ browser, origin }) {
  const { context, page, errors } = await newPage(browser, {
    viewport: { width: 320, height: 700 },
  });
  await page.route('**/_system/contexts', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body['https://schema.sempods.org/writableContext'] = body[
      'https://schema.sempods.org/writableContext'
    ].filter((c) => c['@id'].endsWith('/work'));
    await route.fulfill({ json: body });
  });
  await page.route('**/_system/contexts/*', (route) => {
    const iri = route.request().url();
    return route.fulfill({
      json: {
        '@id': iri,
        '@type': ['http://www.w3.org/ns/sparql-service-description#NamedGraph'],
        'http://www.w3.org/ns/sparql-service-description#name': [
          { '@id': iri },
        ],
        'https://schema.sempods.org/public': [{ '@value': false }],
        'http://www.w3.org/2000/01/rdf-schema#label': [
          { '@value': 'Einkaufsliste' },
        ],
      },
    });
  });
  const results = [];
  try {
    await signIn(page, origin, '/?screen=contexts&lang=de', { choose: false });
    const trigger = page.getByRole('button', {
      name: 'List: Einkaufsliste · work · Privat',
      exact: true,
    });
    await trigger.waitFor();
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await trigger.click();
      const rows = ['work', 'personal'].map((q) =>
        page.getByRole('menuitemradio', {
          name: `Einkaufsliste · ${q}`,
          exact: true,
        }),
      );
      await rows[1].waitFor();
      await settle(page);
      const popup = page.locator('[role="dialog"]:has([role="menu"])');
      const measured = await popup.evaluate((el) => {
        const quiet = [...el.querySelectorAll('[role=menuitemradio] span')]
          .filter((s) => s.textContent?.startsWith(' · '))
          .map((s) => getComputedStyle(s).color);
        const label = el.querySelector('[role=menuitemradio] [slot=label]');
        return {
          quiet,
          label: label && getComputedStyle(label).color,
          right: Math.max(
            ...[...el.querySelectorAll('[role=menuitemradio]')].map(
              (r) => r.getBoundingClientRect().right,
            ),
          ),
          // The fixture's own target output may be wider; the chooser not.
          popup: el.getBoundingClientRect().right,
          trigger: document
            .querySelector('[data-slot=context-switch] button')
            ?.getBoundingClientRect().right,
        };
      });
      results.push({
        id: `qualifier-${scheme}`,
        pass:
          (await rows[0].count()) === 1 &&
          (await rows[1].count()) === 1 &&
          (await page
            .getByRole('group', { name: 'Privat', exact: true })
            .count()) === 1 &&
          measured.quiet.length === 2 &&
          measured.quiet.every((c) => c !== measured.label) &&
          Math.max(measured.right, measured.popup, measured.trigger) <= 320,
        measured,
      });
      await page.addScriptTag({ content: contrastScript });
      const failing = await popup.evaluate((el) =>
        window.uiContrast(el).filter((r) => !r.pass),
      );
      results.push({
        id: `qualifier-contrast-${scheme}`,
        pass: failing.length === 0,
        failing,
      });
      await page.keyboard.press('Escape');
    }
  } catch (error) {
    results.push({
      id: 'qualifier-journey',
      pass: false,
      error: String(error),
    });
  }
  results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
  await context.close();
  return results;
}

/**
 * The app's settings in the access gate (#282): a corner button opens them
 * above the gate, which stays open; language and appearance change in place;
 * Escape closes only the settings, also on repeated presses; on a phone they
 * are a bottom sheet. Then the gate of a remembered Pod: the same settings,
 * and Forget without a write to the Pod.
 */
async function accessSettings({ browser, origin, engine }) {
  const results = [];
  const { context, page, errors } = await newPage(browser);
  const gateOpen = () =>
    page.evaluate(() => {
      const gate = document.querySelector('dialog[data-sempods-ui="gate"]');
      return Boolean(gate?.open && gate.matches(':modal'));
    });
  const settings = page.locator('dialog[data-sempods-ui="settings"]');
  const button = page.locator(
    'dialog[data-sempods-ui="gate"] > .sp-access-settings',
  );
  try {
    await fetch(origin + '/__reset');
    await page.goto(origin + '/');
    await page.locator('dialog[data-sempods-ui="gate"]').waitFor();
    results.push(
      await attempt('settings-button-in-corner', async () => {
        const box = await button.boundingBox();
        const name = await button.getAttribute('aria-label');
        // The gate opens on its own sign-in view, not on the settings button.
        const focus = await page.evaluate(() => ({
          inView: Boolean(
            document.activeElement?.closest(
              'dialog[data-sempods-ui="gate"] [data-sempods-access]',
            ),
          ),
          tag: document.activeElement?.tagName,
        }));
        return {
          pass:
            name === 'Settings' &&
            box !== null &&
            box.width >= 44 &&
            box.height >= 44 &&
            box.x + box.width >= 1280 - 60 &&
            box.y <= 60 &&
            focus.inView,
          name,
          box,
          focus,
        };
      }),
    );
    results.push(
      await attempt('settings-above-the-open-gate', async () => {
        await button.click();
        await settings.waitFor();
        const top = await settings.evaluate((dialog) => {
          const box = dialog.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
          return {
            hit: dialog.contains(hit),
            focusInside: dialog.contains(document.activeElement),
            modal: dialog.matches(':modal'),
          };
        });
        return {
          pass: top.hit && top.focusInside && top.modal && (await gateOpen()),
          ...top,
        };
      }),
    );
    results.push(
      // Plain fieldsets and radio labels, without app CSS (#339): one choice
      // per 44px row, the groups apart.
      await attempt('plain-choices-one-per-row', async () => {
        const rows = await settings.evaluate((dialog) =>
          [...dialog.querySelectorAll('fieldset')].map((fieldset) => ({
            top: fieldset.getBoundingClientRect().top,
            bottom: fieldset.getBoundingClientRect().bottom,
            labels: [...fieldset.querySelectorAll('label')].map((label) => {
              const box = label.getBoundingClientRect();
              return { top: box.top, height: box.height };
            }),
          })),
        );
        const stacked = rows.every((group) =>
          group.labels.every(
            (label, i) =>
              label.height >= 44 &&
              (i === 0 || label.top >= group.labels[i - 1].top + 44 - 0.5),
          ),
        );
        const apart = rows.every(
          (group, i) => i === 0 || group.top >= rows[i - 1].bottom + 8,
        );
        return { pass: rows.length === 2 && stacked && apart, rows };
      }),
    );
    results.push(
      await attempt('language-and-appearance-in-place', async () => {
        await page.evaluate(() => {
          window.sameDocument = true;
        });
        await settings.getByRole('radio', { name: 'Deutsch' }).check();
        await page.getByRole('dialog', { name: 'Einstellungen' }).waitFor();
        await settings.getByRole('radio', { name: 'Dunkel' }).check();
        const after = await page.evaluate(() => {
          const gate = document.querySelector('dialog[data-sempods-ui="gate"]');
          const rgb = getComputedStyle(gate)
            .backgroundColor.match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number);
          return {
            sameDocument: window.sameDocument === true,
            signIn: [...gate.querySelectorAll('button')].some(
              (b) => b.textContent === 'Anmelden',
            ),
            dark: rgb.reduce((a, b) => a + b, 0) < 150,
            rgb,
          };
        });
        return {
          pass:
            after.sameDocument &&
            after.signIn &&
            after.dark &&
            (await gateOpen()),
          ...after,
        };
      }),
    );
    results.push(
      await attempt('escape-closes-only-the-settings', async () => {
        await page.keyboard.press('Escape');
        const closed = await gone(settings);
        const focus = await focusUntil(page, /Einstellungen/, (p) =>
          p.evaluate(
            () => document.activeElement?.getAttribute('aria-label') ?? '',
          ),
        );
        // No activation in between: a close watcher lets a repeated close
        // request through uncancelled; the gate shows again, focus kept.
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        const kept = await page.evaluate(
          () => document.activeElement?.getAttribute('aria-label') ?? '',
        );
        return {
          pass:
            closed &&
            focus === 'Einstellungen' &&
            kept === 'Einstellungen' &&
            (await gateOpen()),
          closed,
          focus,
          kept,
        };
      }),
    );
    results.push(
      await attempt('phone-bottom-sheet-and-backdrop', async () => {
        await page.setViewportSize({ width: 375, height: 812 });
        const corner = await button.boundingBox();
        await button.click();
        await settings.waitFor();
        const sheet = await settings.boundingBox();
        // A press beside the sheet, on its backdrop, closes it.
        await page.mouse.click(187, 20);
        const closed = await gone(settings);
        return {
          pass:
            corner !== null &&
            corner.x + corner.width <= 375 &&
            sheet !== null &&
            Math.abs(sheet.width - 375) <= 1 &&
            Math.abs(sheet.y + sheet.height - 812) <= 2 &&
            closed &&
            (await gateOpen()),
          corner,
          sheet,
          closed,
        };
      }),
    );
  } finally {
    await context.close();
  }
  // The gate's cause ends while its settings are open: both dialogs go and
  // the focus target outside them gets the focus, which a still modal
  // settings dialog would otherwise keep inert.
  const ending = await newPage(browser);
  try {
    const q = ending.page;
    results.push(
      await attempt('cause-ends-with-settings-open', async () => {
        await fetch(origin + '/__reset');
        await q.goto(origin + '/?screen=gate-settings');
        const gate = q.locator('dialog[data-sempods-ui="gate"]');
        await gate.getByRole('button', { name: 'Settings' }).click();
        const dialog = q.locator('dialog[data-sempods-ui="settings"]');
        await dialog.getByRole('radio', { name: 'English' }).focus();
        // Opening a Pod to read without a token ends the gate in place.
        await q.evaluate(
          (pod) => window.gateRuntime.connect(pod),
          origin + '/alice',
        );
        const closed = (await gone(gate)) && (await gone(dialog));
        const focus = await focusUntil(q, /gate-focus-target/, (p) =>
          p.evaluate(() => document.activeElement?.id || 'BODY'),
        );
        return {
          pass: closed && focus === 'gate-focus-target',
          closed,
          focus,
        };
      }),
    );
  } finally {
    await ending.context.close();
  }
  // A remembered Pod: signed in, then signed out through management.
  const remembered = await newPage(browser);
  try {
    const p = remembered.page;
    results.push(
      await attempt(
        'remembered-pod-gate-and-forget-without-writes',
        async () => {
          await signIn(p, origin);
          await p.getByRole('button', { name: 'Menu', exact: true }).click();
          await p.getByRole('menuitem', { name: 'Pods & sharing' }).click();
          // Management stays open above the gate after the sign-out.
          const sheet = p.getByRole('dialog', { name: /Pods & sharing/ });
          await sheet.getByRole('button', { name: 'Sign out' }).click();
          const gate = p.locator('dialog[data-sempods-ui="gate"]');
          await gate
            .getByRole('button', { name: 'Sign in', exact: true })
            .waitFor();
          await sheet.getByRole('button', { name: 'Close' }).click();
          await gone(sheet);
          await gate.getByRole('button', { name: 'Settings' }).click();
          const dialog = p.locator('dialog[data-sempods-ui="settings"]');
          await dialog.getByRole('radio', { name: 'Deutsch' }).check();
          await dialog.getByRole('button', { name: 'Schließen' }).click();
          await gone(dialog);
          await gate.getByRole('button', { name: 'Pod auswählen' }).click();
          await gate
            .getByText('Gespeicherte Pods verwalten', { exact: true })
            .click();
          const list = gate.getByRole('list', {
            name: 'Pods auf diesem Gerät',
          });
          const kept = await shown(list);
          const writes = [];
          p.on('request', (request) => {
            if (request.method() !== 'GET' && request.url().startsWith(origin))
              writes.push(request.method() + ' ' + request.url());
          });
          await list
            .getByRole('button', { name: 'Von diesem Gerät entfernen' })
            .click();
          const forgotten = await gone(list);
          await p.waitForTimeout(200);
          return {
            pass: kept && forgotten && writes.length === 0,
            kept,
            forgotten,
            writes,
          };
        },
      ),
    );
  } finally {
    await remembered.context.close();
  }
  results.push({
    id: 'no-page-errors',
    pass:
      errors.length === 0 &&
      ending.errors.length === 0 &&
      remembered.errors.length === 0,
    errors: [...errors, ...ending.errors, ...remembered.errors],
    engine,
  });
  return results;
}

/**
 * The startup screen while a saved session restores (#304): at 375px and on
 * a desktop, light and dark, with the Pod's discovery held. It covers the
 * viewport without controls or overflow, keeps the content inert, measures
 * its contrast, adds its status after the delay and gives way to the app.
 * With SEMPODS_UI_SCREENSHOTS set to a directory, each state is saved there.
 */
async function startup({ browser, origin, engine }) {
  const results = [];
  const { context, page, errors } = await newPage(browser);
  const shots = process.env.SEMPODS_UI_SCREENSHOTS;
  let release = () => {};
  let held = Promise.resolve();
  await page.route('**/.well-known/oauth-protected-resource', async (route) => {
    await held;
    await route.continue();
  });
  try {
    await signIn(page, origin);
    const layer = page.locator('[data-sempods-startup]');
    for (const [width, height] of [
      [375, 812],
      [1280, 800],
    ])
      for (const scheme of ['light', 'dark']) {
        const id = `${width}-${scheme}`;
        held = new Promise((resolve) => (release = resolve));
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(origin + '/');
        await layer.waitFor();
        results.push(
          await attemptOn(errors, `screen-${id}`, async () => {
            const status = layer.getByRole('status');
            await status.filter({ hasText: 'Starting…' }).waitFor();
            await settle(page);
            if (shots)
              await page.screenshot({
                path: `${shots}/startup-${engine}-${id}.png`,
              });
            const measured = await page.evaluate(() => {
              const el = document.querySelector('[data-sempods-startup]');
              const box = el.getBoundingClientRect();
              const heading = el.querySelector('h1').getBoundingClientRect();
              return {
                covers:
                  box.left <= 0 &&
                  box.top <= 0 &&
                  box.right >= innerWidth &&
                  box.bottom >= innerHeight,
                centred:
                  Math.abs(heading.left + heading.width / 2 - innerWidth / 2) <=
                  2,
                overflow:
                  document.scrollingElement.scrollWidth > innerWidth ||
                  el.scrollWidth > el.clientWidth,
                controls: el.querySelectorAll(
                  'button, a, input, select, textarea, [tabindex]',
                ).length,
                inert: Boolean(
                  document.querySelector('main')?.closest('[inert]'),
                ),
                gate: Boolean(
                  document.querySelector('[data-sempods-ui="gate"]'),
                ),
                focusInside: el.contains(document.activeElement),
              };
            });
            await page.addScriptTag({ content: contrastScript });
            const failing = await layer.evaluate((el) =>
              window.uiContrast(el).filter((r) => !r.pass),
            );
            return {
              pass:
                measured.covers &&
                measured.centred &&
                !measured.overflow &&
                measured.controls === 0 &&
                measured.inert &&
                !measured.gate &&
                !measured.focusInside &&
                failing.length === 0,
              measured,
              failing,
            };
          }),
        );
        results.push(
          await attemptOn(errors, `ends-${id}`, async () => {
            release();
            await loaded(page);
            await layer.waitFor({ state: 'detached' });
            const inert = await page.evaluate(() =>
              Boolean(document.querySelector('main')?.closest('[inert]')),
            );
            if (shots)
              await page.screenshot({
                path: `${shots}/started-${engine}-${id}.png`,
              });
            return { pass: !inert, inert };
          }),
        );
      }
    // An app that loads its theme while startup is pending (#315 review): a
    // `:root` token that changes is followed by the startup screen.
    held = new Promise((resolve) => (release = resolve));
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(origin + '/');
    await layer.waitFor();
    results.push(
      await attemptOn(errors, 'follows-root-theme', async () => {
        const background = () =>
          layer.evaluate((el) => getComputedStyle(el).backgroundColor);
        await page.evaluate(() =>
          document.documentElement.style.setProperty(
            '--sempods-bg',
            'rgb(1, 2, 3)',
          ),
        );
        const before = await background();
        await page.evaluate(() =>
          document.documentElement.style.setProperty(
            '--sempods-bg',
            'rgb(4, 5, 6)',
          ),
        );
        const after = await background();
        const still = await layer.count();
        return {
          pass:
            before === 'rgb(1, 2, 3)' &&
            after === 'rgb(4, 5, 6)' &&
            still === 1,
          before,
          after,
        };
      }),
    );
    release();
    await loaded(page);
  } finally {
    release();
  }
  results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
  await context.close();
  return results;
}

/**
 * A multi-Pod app's sources panel on `?screen=add-pod` (#329): the SDK's
 * PodChooser adds another Pod while signed in, with the sign-in's field,
 * keyboard and labels, in the app's own nonmodal panel.
 */
async function addPod({ browser, origin, engine }) {
  const results = [];
  const { context, page, errors } = await newPage(browser);
  const shots = process.env.SEMPODS_UI_SCREENSHOTS;
  const panel = page.getByRole('region', { name: 'Sources' });
  const group = page.getByRole('group', { name: 'Connect another Pod' });
  const field = group.getByRole('combobox', { name: 'Pod address' });
  const primary = group.locator('.sp-access-primary');
  const pods = page.getByRole('list', { name: 'Connected Pods' });
  const closed = () => page.getByTestId('panel-closed').textContent();
  try {
    await signIn(page, origin, '/?screen=add-pod', { choose: false });
    await field.waitFor();
    for (const [width, height] of [
      [375, 812],
      [1280, 800],
    ])
      for (const scheme of ['light', 'dark']) {
        const id = `${width}-${scheme}`;
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: scheme });
        await settle(page);
        results.push(
          await attemptOn(errors, `in-panel-${id}`, async () => {
            if (shots)
              await page.screenshot({
                path: `${shots}/add-pod-${engine}-${id}.png`,
              });
            const measured = await group.evaluate((el) => {
              const style = getComputedStyle(el);
              const box = el.getBoundingClientRect();
              const parent = getComputedStyle(el.parentElement);
              const host =
                el.parentElement.clientWidth -
                parseFloat(parent.paddingLeft) -
                parseFloat(parent.paddingRight);
              return {
                padding: style.padding,
                align: style.textAlign,
                background: style.backgroundColor,
                fills: Math.abs(box.width - host) <= 1,
                host,
                width: box.width,
                overflow:
                  document.scrollingElement.scrollWidth > innerWidth ||
                  el.scrollWidth > el.clientWidth,
              };
            });
            await page.addScriptTag({ content: contrastScript });
            const failing = await group.evaluate((el) =>
              window.uiContrast(el).filter((r) => !r.pass),
            );
            return {
              pass:
                (await field.inputValue()) === 'https://sempods.org/' &&
                (await primary.textContent()) === 'Sign in' &&
                (await primary.isDisabled()) &&
                measured.padding === '0px' &&
                measured.align === 'start' &&
                measured.background === 'rgba(0, 0, 0, 0)' &&
                measured.fills &&
                !measured.overflow &&
                failing.length === 0,
              measured,
              failing,
            };
          }),
        );
      }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: 'light' });
    results.push(
      await attemptOn(errors, 'escape-closes-only-the-list', async () => {
        await field.focus();
        await page.keyboard.press('ArrowDown');
        await group.getByRole('option').first().waitFor();
        const expanded = await field.getAttribute('aria-expanded');
        const options = await group.getByRole('option').count();
        await page.keyboard.press('Escape');
        await settle(page);
        const after = await field.getAttribute('aria-expanded');
        return {
          pass:
            expanded === 'true' &&
            options === 1 &&
            after === 'false' &&
            (await closed()) === '0' &&
            (await panel.isVisible()) &&
            (await field.evaluate((el) => el === document.activeElement)),
          expanded,
          options,
          after,
        };
      }),
    );
    results.push(
      await attemptOn(errors, 'matches-a-connected-pod', async () => {
        await field.fill(origin + '/alice/');
        const label = await primary.textContent();
        const count = await pods.getByRole('listitem').count();
        return {
          pass: label === 'Change sharing' && count === 1,
          label,
          count,
        };
      }),
    );
    results.push(
      await attemptOn(
        errors,
        'signs-in-to-another-pod-by-keyboard',
        async () => {
          await field.focus();
          await field.press('ControlOrMeta+a');
          await page.keyboard.type(origin + '/bob');
          await page.keyboard.press('Enter');
          await pods
            .locator('li[data-session="active"]')
            .nth(1)
            .waitFor({ timeout: 15000 });
          const listed = (
            await pods.getByRole('listitem').allTextContents()
          ).sort();
          await field.waitFor();
          return {
            pass:
              listed.length === 2 &&
              listed[0] === origin + '/alice' &&
              listed[1] === origin + '/bob' &&
              (await field.inputValue()) === 'https://sempods.org/',
            listed,
          };
        },
      ),
    );
  } finally {
    results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
    await context.close();
  }
  return results;
}

/**
 * The kit's Checkbox (#337) on `?screen=checkbox`: a 44px target around its
 * 20px box, Space and a press tick it, a solid focus outline for the
 * keyboard (also with forced colors),
 * a disabled box stays as it is, and its check mark does not rest on colour.
 */
async function checkbox({ browser, origin }) {
  const { context, page, errors } = await newPage(browser);
  const box = (name) => page.getByRole('checkbox', { name, exact: true });
  const checked = (name) => box(name).isChecked();
  const results = [];
  try {
    await page.goto(origin + '/?screen=checkbox');
    await box('Done: Buy milk').waitFor({ state: 'attached' });
    results.push(
      await attempt('target-44-around-the-box', async () => {
        const hits = await page.evaluate(() => {
          const el = document.querySelector('[data-slot="checkbox"]');
          const r = el.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const at = (x, y) => el.contains(document.elementFromPoint(x, y));
          return {
            box: [r.width, r.height],
            edges: [
              at(cx - 21, cy),
              at(cx + 21, cy),
              at(cx, cy - 21),
              at(cx, cy + 21),
            ],
          };
        });
        return {
          pass:
            hits.box[0] === 20 &&
            hits.box[1] === 20 &&
            hits.edges.every(Boolean),
          ...hits,
        };
      }),
    );
    results.push(
      await attempt('press-at-the-edge-ticks', async () => {
        const r = await page
          .locator('[data-slot="checkbox"]')
          .first()
          .boundingBox();
        await page.mouse.click(r.x + r.width / 2 + 20, r.y + r.height / 2);
        const after = await checked('Done: Buy milk');
        return { pass: after === true, after };
      }),
    );
    results.push(
      await attempt('space-ticks-with-a-focus-outline', async () => {
        // Keyboard from the top of the page: the first two boxes.
        await page.locator('body').click({ position: { x: 1, y: 700 } });
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() =>
          document.activeElement?.getAttribute('aria-label'),
        );
        // The visible box draws a solid outline, in ordinary and in forced
        // colors, where the ring's box shadow is dropped (#348 review).
        const outline = {};
        for (const forcedColors of ['none', 'active']) {
          await page.emulateMedia({ forcedColors });
          outline[forcedColors] = await page.evaluate(() => {
            const el = document.activeElement?.closest(
              '[data-slot="checkbox"]',
            );
            const style = el ? getComputedStyle(el) : null;
            return style
              ? `${style.outlineStyle} ${style.outlineWidth}`
              : 'no box';
          });
        }
        await page.emulateMedia({ forcedColors: null });
        const before = await checked('Done: Buy bread');
        await page.keyboard.press('Space');
        const after = await checked('Done: Buy bread');
        return {
          pass:
            focused === 'Done: Buy bread' &&
            outline.none === 'solid 2px' &&
            outline.active === 'solid 2px' &&
            before === true &&
            after === false,
          focused,
          outline,
          before,
          after,
        };
      }),
    );
    results.push(
      await attempt('disabled-stays', async () => {
        await page
          .locator('[data-slot="checkbox"]')
          .nth(2)
          .click({ force: true });
        const after = await checked('Done: Locked');
        return { pass: after === true, after };
      }),
    );
    results.push(
      await attempt('check-mark-and-visible-label', async () => {
        await page.locator('[data-slot="checkbox"]').last().click();
        const state = await page.evaluate(() => {
          const boxes = [
            ...document.querySelectorAll('[data-slot="checkbox"]'),
          ];
          return boxes.map((el) => ({
            selected: el.hasAttribute('data-selected'),
            mark: Boolean(el.querySelector('svg')),
          }));
        });
        const remember = await checked('Remember this device');
        return {
          pass:
            remember &&
            state.every((s) => s.selected === s.mark) &&
            state.some((s) => s.mark),
          remember,
          state,
        };
      }),
    );
  } finally {
    results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
    await context.close();
  }
  return results;
}

/**
 * The README's views as links on `?screen=tabs` (#342, #343): `nav.link`
 * marks the link to the shown view with `aria-current="page"` through clicks,
 * Back and a task's screen over a view, which marks neither view. The current
 * ghost link has the same text colour as the other one, a surface of its own
 * and an underline, rest and hovered, apart from the other link hovered,
 * under both palettes, all six action variants and both schemes.
 */
async function viewTabs({ browser, origin }) {
  const { context, page, errors } = await newPage(browser, {
    reducedMotion: 'reduce',
  });
  const link = (name) => page.getByRole('link', { name, exact: true });
  const marked = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('a[aria-current]')].map(
        (el) => `${el.textContent} ${el.getAttribute('aria-current')}`,
      ),
    );
  const at = (path) => page.waitForURL((url) => url.pathname === path);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const results = [];
  try {
    await page.goto(origin + '/?screen=tabs');
    await link('Zen').waitFor();
    results.push(
      await attemptOn(errors, 'current-follows-the-shown-view', async () => {
        const start = await marked();
        await link('List').click();
        await at('/list');
        const list = await marked();
        await page.goBack();
        await at('/');
        const back = await marked();
        return {
          pass:
            same(start, ['Zen page']) &&
            same(list, ['List page']) &&
            same(back, ['Zen page']),
          start,
          list,
          back,
        };
      }),
    );
    results.push(
      await attemptOn(
        errors,
        'a-screen-over-a-view-marks-neither',
        async () => {
          await link('Open a task').click();
          await page.locator('#tabs-place', { hasText: 'task' }).waitFor();
          const over = await marked();
          await page.goBack();
          await at('/');
          const back = await marked();
          return {
            pass: same(over, ['Open a task page']) && same(back, ['Zen page']),
            over,
            back,
          };
        },
      ),
    );
    // The look of both links, rest and hovered, as the browser paints it.
    const look = () =>
      page.evaluate(() => {
        const of = (name) => {
          const el = [...document.querySelectorAll('nav a')].find(
            (a) => a.textContent === name,
          );
          const s = getComputedStyle(el);
          return {
            color: s.color,
            background: s.backgroundColor,
            underline: s.textDecorationLine.includes('underline'),
            text: window.uiContrast(el).filter((m) => m.kind === 'text'),
          };
        };
        return { zen: of('Zen'), list: of('List') };
      });
    await context.addInitScript(contrastScript);
    for (const theme of ['default', 'fresh'])
      for (const actions of ['solid', 'inverted'])
        for (const secondary of ['tonal', 'outline', 'text'])
          for (const scheme of ['light', 'dark'])
            results.push(
              await attemptOn(
                errors,
                `current-link-chosen ${theme}/${actions}/${secondary} ${scheme}`,
                async () => {
                  await page.emulateMedia({ colorScheme: scheme });
                  await page.goto(
                    origin +
                      `/?screen=tabs&theme=${theme}&actions=${actions}&secondary=${secondary}`,
                  );
                  await link('Zen').waitFor();
                  await page.mouse.move(1, 1);
                  await settle(page);
                  const rest = await look();
                  await link('List').hover();
                  await settle(page);
                  const otherHovered = (await look()).list;
                  await link('Zen').hover();
                  await settle(page);
                  const currentHovered = (await look()).zen;
                  const { zen, list } = rest;
                  const texts = [zen, currentHovered].flatMap((l) => l.text);
                  return {
                    pass:
                      zen.color === list.color &&
                      zen.underline &&
                      !list.underline &&
                      !otherHovered.underline &&
                      zen.background !== list.background &&
                      currentHovered.underline &&
                      currentHovered.background === zen.background &&
                      texts.length === 2 &&
                      texts.every((m) => m.pass),
                    rest,
                    otherHovered,
                    currentHovered,
                  };
                },
              ),
            );
  } finally {
    results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
    await context.close();
  }
  return results;
}

/**
 * The README's views on one baseline on `?screen=strip` (#384). A tap on a
 * touch screen switches to List and back, a pointer click and leaving keep
 * the bar on the current link, and in forced colors Tab and Enter switch with
 * a focus outline apart from the bar. Throughout, both links rest and stay
 * chosen without a surface or a text underline, the labels cannot be
 * selected and draw no tap highlight, and only the current link has a bar on
 * the row's baseline, which forced colors keep; Filter, reached by Tab, has
 * its own outline. At 320 and 375px with long counts, at a root font size of
 * 100% and 125%, the strip and its trailing Filter action stay inside the
 * screen, every count on one line, with targets of 2.75rem. WebKit matches forced colors without forcing the
 * colours, so there the check shows the keyboard path only.
 */
async function viewStrip({ browser, origin, engine }) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const clear = (color) =>
    !color || /^(rgba\(\d+, \d+, \d+, 0\)|transparent)$/.test(color);
  /** The strip as the browser draws it. */
  const read = (page) =>
    page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Views"]');
      const row = nav.parentElement;
      const rowBox = row.getBoundingClientRect();
      const rowStyle = getComputedStyle(row);
      const rem = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const links = [...nav.querySelectorAll('a')].map((a) => {
        const s = getComputedStyle(a);
        const after = getComputedStyle(a, '::after');
        const box = a.getBoundingClientRect();
        const parts = [...a.children].map((part) => {
          const range = document.createRange();
          range.selectNodeContents(part);
          return {
            text: part.textContent,
            box: part.getBoundingClientRect().toJSON(),
            lines: new Set(
              [...range.getClientRects()].map((r) => Math.round(r.top)),
            ).size,
          };
        });
        return {
          name: a.textContent,
          current: a.getAttribute('aria-current'),
          focused: a === document.activeElement,
          anchored: s.position === 'relative',
          color: s.color,
          background: s.backgroundColor,
          underline: s.textDecorationLine.includes('underline'),
          outline:
            s.outlineStyle === 'none' || s.outlineWidth === '0px'
              ? null
              : { width: parseFloat(s.outlineWidth), color: s.outlineColor },
          select: s.userSelect || s.webkitUserSelect,
          tap: s.webkitTapHighlightColor ?? null,
          bar:
            after.borderBottomStyle === 'none' ||
            after.borderBottomWidth === '0px'
              ? null
              : {
                  width: parseFloat(after.borderBottomWidth),
                  color: after.borderBottomColor,
                  edge:
                    after.position === 'absolute' &&
                    after.left === '0px' &&
                    after.right === '0px' &&
                    after.bottom === '-1px',
                },
          box: box.toJSON(),
          parts,
        };
      });
      const button = document.querySelector('[aria-label="Filter"]');
      const buttonStyle = getComputedStyle(button);
      const action = {
        ...button.getBoundingClientRect().toJSON(),
        focused: button === document.activeElement,
        outline:
          buttonStyle.outlineStyle === 'none' ||
          buttonStyle.outlineWidth === '0px'
            ? null
            : parseFloat(buttonStyle.outlineWidth),
      };
      return {
        place: document.querySelector('#strip-place').textContent,
        filtered: document.querySelector('#strip-filtered').textContent,
        actionInNav: Boolean(nav.querySelector('[aria-label="Filter"]')),
        selection: window.getSelection()?.toString() ?? '',
        forced: window.matchMedia('(forced-colors: active)').matches,
        page: getComputedStyle(document.body).backgroundColor,
        rem,
        width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        baseline: {
          width: parseFloat(rowStyle.borderBottomWidth),
          style: rowStyle.borderBottomStyle,
          bottom: rowBox.bottom,
        },
        nav: nav.getBoundingClientRect().toJSON(),
        action,
        links,
      };
    });
  /**
   * Only `current` is marked and has a bar on the baseline, which `page`
   * shows apart from the page; no link has a surface or a text underline,
   * a selectable label or a tap highlight.
   */
  const drawn = (state, current) =>
    state.links.length === 2 &&
    state.baseline.style === 'solid' &&
    state.baseline.width >= 1 &&
    state.links.every(
      (l) =>
        (l.current === 'page') === l.name.startsWith(current) &&
        Boolean(l.bar) === (l.current === 'page') &&
        (!l.bar ||
          (l.bar.edge &&
            l.anchored &&
            l.bar.width >= 3 &&
            !clear(l.bar.color) &&
            l.bar.color !== state.page)) &&
        Math.abs(
          l.box.bottom - (state.baseline.bottom - state.baseline.width),
        ) <= 0.5 &&
        clear(l.background) &&
        !l.underline &&
        l.select === 'none' &&
        (l.tap === null || clear(l.tap)),
    ) &&
    state.selection === '';
  const results = [];

  // A tap on a touch screen, from Zen to List and back.
  {
    const { context, page, errors } = await newPage(browser, {
      viewport: { width: 375, height: 812 },
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    try {
      results.push(
        await attemptOn(errors, 'strip-touch-switch', async () => {
          await page.goto(origin + '/?screen=strip');
          const link = (name) =>
            page.getByRole('link', { name: new RegExp(`^${name} \\d`) });
          await link('Zen').waitFor();
          const start = await read(page);
          await link('List').tap();
          await page.waitForURL((url) => url.pathname === '/list');
          await settle(page);
          const list = await read(page);
          await link('Zen').tap();
          await page.waitForURL((url) => url.pathname === '/');
          await settle(page);
          const zen = await read(page);
          // The accessible names keep the space between label and count.
          const names = await page
            .getByRole('navigation', { name: 'Views' })
            .getByRole('link')
            .count();
          const named = await Promise.all(
            ['Zen 3', 'List 12'].map((name) =>
              page.getByRole('link', { name, exact: true }).count(),
            ),
          );
          return {
            pass:
              names === 2 &&
              same(named, [1, 1]) &&
              // No hover colour stays on List after the tap back to Zen.
              same(
                zen.links.map((l) => l.color),
                start.links.map((l) => l.color),
              ) &&
              drawn(start, 'Zen') &&
              list.place === 'list' &&
              drawn(list, 'List') &&
              zen.place === 'zen' &&
              drawn(zen, 'Zen'),
            named,
            start,
            list,
            zen,
          };
        }),
      );
    } finally {
      results.push({
        id: 'strip-touch-no-page-errors',
        pass: errors.length === 0,
        errors,
      });
      await context.close();
    }
  }

  const { context, page, errors } = await newPage(browser, {
    reducedMotion: 'reduce',
  });
  const link = (name) =>
    page.getByRole('link', { name: new RegExp(`^${name} \\d`) });
  const filter = page.getByRole('button', { name: 'Filter', exact: true });
  try {
    // A pointer: hovering List, clicking it and leaving; then Filter.
    for (const scheme of ['light', 'dark'])
      results.push(
        await attemptOn(errors, `strip-pointer-switch ${scheme}`, async () => {
          await page.emulateMedia({ colorScheme: scheme });
          await page.goto(origin + '/?screen=strip');
          await link('Zen').waitFor();
          await page.mouse.move(1, 1);
          await settle(page);
          const rest = await read(page);
          await link('List').hover();
          await settle(page);
          const hovered = await read(page);
          await link('List').click();
          await page.waitForURL((url) => url.pathname === '/list');
          await settle(page);
          const pressed = await read(page);
          await page.mouse.move(1, 1);
          await settle(page);
          const left = await read(page);
          await filter.click();
          await page.locator('#strip-filtered', { hasText: '1' }).waitFor();
          const filtered = await read(page);
          const [zen, list] = rest.links;
          return {
            pass:
              drawn(rest, 'Zen') &&
              // Hovering a link lightens its text, without a bar.
              drawn(hovered, 'Zen') &&
              hovered.links[1].color === zen.color &&
              list.color !== zen.color &&
              pressed.place === 'list' &&
              drawn(pressed, 'List') &&
              drawn(left, 'List') &&
              // A pointer leaves no focus outline on the links.
              [rest, hovered, pressed, left].every((state) =>
                state.links.every((l) => !l.outline),
              ) &&
              filtered.filtered === '1' &&
              filtered.place === 'list' &&
              !filtered.actionInNav &&
              drawn(filtered, 'List'),
            rest,
            hovered,
            pressed,
            left,
            filtered,
          };
        }),
      );
    // The keyboard in forced colors: Tab to each link, Enter on List, Tab to
    // Filter, back with Shift+Tab and Enter on Zen.
    results.push(
      await attemptOn(errors, 'strip-keyboard-forced-colors', async () => {
        const tab = tabKey(engine);
        const back = tab.replace('Tab', 'Shift+Tab');
        await page.emulateMedia({
          colorScheme: 'light',
          forcedColors: 'active',
        });
        await page.goto(origin + '/?screen=strip');
        await link('Zen').waitFor();
        const steps = {};
        await page.keyboard.press(tab);
        await settle(page);
        steps.zen = await read(page);
        await page.keyboard.press(tab);
        await settle(page);
        steps.list = await read(page);
        await page.keyboard.press('Enter');
        await page.waitForURL((url) => url.pathname === '/list');
        await settle(page);
        steps.listCurrent = await read(page);
        await page.keyboard.press(tab);
        await page.keyboard.press('Enter');
        await page.locator('#strip-filtered', { hasText: '1' }).waitFor();
        steps.filtered = await read(page);
        await page.keyboard.press(back);
        await page.keyboard.press(back);
        await settle(page);
        steps.zenAgain = await read(page);
        await page.keyboard.press('Enter');
        await page.waitForURL((url) => url.pathname === '/');
        await settle(page);
        steps.zenCurrent = await read(page);
        /** `focused` alone has a focus outline of 2px or more. */
        const ring = (state, focused) =>
          state.links.every(
            (l) =>
              l.focused === l.name.startsWith(focused) &&
              Boolean(l.outline) === l.focused &&
              (!l.outline || l.outline.width >= 2),
          );
        return {
          pass:
            Object.values(steps).every((s) => s.forced) &&
            drawn(steps.zen, 'Zen') &&
            ring(steps.zen, 'Zen') &&
            // The focus on List and the bar on Zen: two indicators apart.
            drawn(steps.list, 'Zen') &&
            ring(steps.list, 'List') &&
            steps.listCurrent.place === 'list' &&
            drawn(steps.listCurrent, 'List') &&
            ring(steps.listCurrent, 'List') &&
            steps.filtered.filtered === '1' &&
            steps.filtered.action.focused &&
            steps.filtered.action.outline >= 2 &&
            steps.filtered.links.every((l) => !l.focused && !l.outline) &&
            drawn(steps.zenAgain, 'List') &&
            ring(steps.zenAgain, 'Zen') &&
            steps.zenCurrent.place === 'zen' &&
            drawn(steps.zenCurrent, 'Zen') &&
            ring(steps.zenCurrent, 'Zen'),
          ...steps,
        };
      }),
    );
    await page.emulateMedia({ colorScheme: null, forcedColors: null });
    // Long counts on narrow screens, also with a larger root font size.
    for (const width of [320, 375])
      for (const font of ['100%', '125%'])
        results.push(
          await attemptOn(
            errors,
            `strip-long-counts ${width}px ${font}`,
            async () => {
              await page.setViewportSize({ width, height: 800 });
              await page.goto(origin + '/?screen=strip&counts=long');
              await link('Zen').waitFor();
              await page.evaluate((size) => {
                document.documentElement.style.fontSize = size;
              }, font);
              await settle(page);
              const state = await read(page);
              const target = 2.75 * state.rem - 0.5;
              const inside = (inner, outer) =>
                inner.left >= outer.left - 0.5 &&
                inner.right <= outer.right + 0.5 &&
                inner.top >= outer.top - 0.5 &&
                inner.bottom <= outer.bottom + 0.5;
              const screen = {
                left: 0,
                top: 0,
                right: state.width,
                bottom: 800,
              };
              const counts = state.links.map((l) => l.parts[1]?.text);
              return {
                pass:
                  !state.overflow &&
                  drawn(state, 'Zen') &&
                  same(counts, ['12,345', '1,234,567']) &&
                  state.links.every(
                    (l) =>
                      l.box.height >= target &&
                      inside(l.box, state.nav) &&
                      l.parts.length === 2 &&
                      l.parts.every((p) => inside(p.box, l.box)) &&
                      // A count never breaks inside the number.
                      l.parts[1].lines === 1,
                  ) &&
                  inside(state.nav, screen) &&
                  inside(state.action, screen) &&
                  state.action.left >= state.nav.right &&
                  state.action.width >= target &&
                  state.action.height >= target,
                state,
              };
            },
          ),
        );
  } finally {
    results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
    await context.close();
  }
  return results;
}

/**
 * A short confirmation with long German labels and a long unbroken list name
 * (#368), on `?screen=confirm`: the README's `ConfirmDialog` and, with
 * `&footer=pill`, the same parts holding `ActionButton` pills. At 1280, 375
 * and 320px (1280px at 400% browser zoom), light and dark: the dialog and
 * every text in it inside the screen and the dialog, its actions inside the
 * footer with room for their focus rings, 44px targets (56px pills), Cancel
 * before the answer in reading order (left of it, or above it once they
 * wrap), and side by side on the desktop for the README's buttons. By
 * keyboard, Tab reaches Cancel, then the answer, which Enter gives.
 */
async function confirmation({ browser, origin, engine }) {
  const { context, page, errors } = await newPage(browser);
  const dialog = page.getByRole('dialog', {
    name: 'Gekaufte Artikel löschen?',
  });
  const results = [];
  try {
    for (const footer of ['button', 'pill']) {
      const address =
        origin + `/?screen=confirm${footer === 'pill' ? '&footer=pill' : ''}`;
      results.push(
        await attempt(`confirm-footer-inside-${footer}`, async () => {
          const cases = [];
          try {
            for (const width of [1280, 375, 320])
              for (const scheme of ['light', 'dark']) {
                await page.setViewportSize({ width, height: 800 });
                await page.emulateMedia({ colorScheme: scheme });
                await page.goto(address);
                await dialog.waitFor();
                await settle(page);
                const m = await page.evaluate(() => {
                  const content = document.querySelector(
                    '[data-slot=dialog-content]',
                  );
                  const frame = content.getBoundingClientRect();
                  const foot = content
                    .querySelector('[data-slot=dialog-footer]')
                    .getBoundingClientRect();
                  const within = (r, f, pad = 0) =>
                    r.left - pad >= f.left - 0.5 &&
                    r.right + pad <= f.right + 0.5 &&
                    r.top - pad >= f.top - 0.5 &&
                    r.bottom + pad <= f.bottom + 0.5;
                  // Each line of text inside the dialog, and a label inside
                  // its button.
                  const walker = document.createTreeWalker(
                    content,
                    4, // NodeFilter.SHOW_TEXT
                  );
                  const spilled = [];
                  for (let node; (node = walker.nextNode());) {
                    if (!node.textContent.trim()) continue;
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    const owner =
                      node.parentElement.closest('button') ?? content;
                    const box = owner.getBoundingClientRect();
                    for (const line of range.getClientRects())
                      if (!within(line, box))
                        spilled.push(node.textContent.slice(0, 24));
                  }
                  const buttons = [
                    ...content.querySelectorAll(
                      '[data-slot=dialog-footer] > button',
                    ),
                  ].map((b) => ({
                    label: b.textContent,
                    pill: b.dataset.shape === 'pill',
                    rect: b.getBoundingClientRect().toJSON(),
                  }));
                  const [cancel, answer] = buttons.map((b) => b.rect);
                  const sideBySide =
                    Math.abs(cancel.top - answer.top) < 1 &&
                    cancel.right <= answer.left;
                  return {
                    labels: buttons.map((b) => b.label),
                    targets: buttons.map((b) => [
                      Math.round(b.rect.width),
                      Math.round(b.rect.height),
                    ]),
                    sized: buttons.every(
                      (b) =>
                        b.rect.width >= 44 &&
                        b.rect.height >= (b.pill ? 56 : 44),
                    ),
                    // React Aria's focus ring is 3px outside the button.
                    rings: buttons.every((b) => within(b.rect, foot, 3)),
                    footerInside: within(foot, frame),
                    dialogInside:
                      frame.left >= 16 - 0.5 &&
                      frame.right <= innerWidth - 16 + 0.5,
                    noSideScroll:
                      document.documentElement.scrollWidth <= innerWidth,
                    spilled,
                    sideBySide,
                    inOrder: sideBySide || cancel.bottom <= answer.top + 0.5,
                  };
                });
                cases.push({ width, scheme, ...m });
              }
          } finally {
            await page.emulateMedia({ colorScheme: null });
            await page.setViewportSize({ width: 1280, height: 800 });
          }
          return {
            pass:
              cases.length === 6 &&
              cases.every(
                (c) =>
                  c.labels.join('|') === 'Abbrechen|Gekaufte Artikel löschen' &&
                  c.sized &&
                  c.rings &&
                  c.footerInside &&
                  c.dialogInside &&
                  c.noSideScroll &&
                  c.spilled.length === 0 &&
                  c.inOrder &&
                  (footer === 'pill' || c.width !== 1280 || c.sideBySide),
              ),
            cases,
          };
        }),
      );
      results.push(
        await attempt(`confirm-keyboard-${footer}`, async () => {
          const tab = tabKey(engine);
          await page.goto(address);
          await dialog.waitFor();
          await settle(page);
          const focused = [];
          for (let i = 0; i < 2; i++) {
            await page.keyboard.press(tab);
            focused.push(
              await page.evaluate(() => document.activeElement?.textContent),
            );
          }
          await page.keyboard.press('Enter');
          const closed = await gone(dialog);
          const answer = await page
            .locator('output')
            .getAttribute('data-answer');
          return {
            pass:
              focused.join('|') === 'Abbrechen|Gekaufte Artikel löschen' &&
              closed &&
              answer === 'confirmed',
            focused,
            closed,
            answer,
          };
        }),
      );
    }
  } finally {
    results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
    await context.close();
  }
  return results;
}

/**
 * A menu action that asks first (#391): the README's confirmation opens while
 * the menu is still in its exit animation and is answered at once, by pointer
 * or by keyboard. The menu opened again by pointer right away, or by Enter
 * once the focus is back on its button, takes the focus, moves with the arrow
 * keys, closes with Escape and hands the focus back to its button; at 375px,
 * in both colour schemes. A menu closed without a dialog still plays its exit
 * animation.
 */
async function menuDialog({ browser, origin, engine }) {
  const tab = tabKey(engine);
  const { context, page, errors } = await newPage(browser, {
    viewport: { width: 375, height: 812 },
  });
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  const confirm = page.getByRole('dialog', { name: 'Delete bought items?' });
  // Whether the menu that opened the confirmation is still leaving.
  const exiting = () =>
    page.evaluate(() =>
      Boolean(
        document.querySelector(
          '[data-slot=dropdown-menu-content][data-exiting]',
        ),
      ),
    );
  const results = [];
  try {
    for (const scheme of ['light', 'dark'])
      for (const how of ['pointer', 'keyboard-answer', 'keyboard']) {
        results.push(
          await attemptOn(errors, `menu-dialog-${how}-${scheme}`, async () => {
            await page.emulateMedia({ colorScheme: scheme });
            await page.goto(origin + '/?screen=menu-confirm');
            await menu.waitFor();
            await settle(page);
            // Ask and answer without waiting for the menu's exit.
            if (how === 'pointer') {
              await menu.click();
              await page
                .getByRole('menuitem', { name: 'Delete bought items' })
                .click();
              await confirm.getByRole('button', { name: 'Delete' }).click();
            } else {
              await menu.focus();
              await page.keyboard.press('Enter');
              await page
                .getByRole('menuitem', { name: 'Rename list' })
                .waitFor();
              await focusItem(page, 'Delete bought items');
              await page.keyboard.press('Enter');
              await confirm.waitFor();
              await page.keyboard.press(tab);
              await page.keyboard.press(tab);
              await page.keyboard.press('Enter');
            }
            let duringExit = await exiting();
            let returned = null;
            if (how === 'keyboard') {
              // The focus goes back to the button, where Enter opens again.
              returned = await focusUntil(page, /Menu/, focused);
              duringExit = await exiting();
              await page.keyboard.press('Enter');
            } else await menu.click();
            const answered = await page
              .locator('output')
              .getAttribute('data-done');
            const menuShown = await shown(
              page.getByRole('menuitem', { name: 'Rename list' }),
            );
            const reopened = await focusUntil(
              page,
              /^menuitem|^menu /,
              focused,
            );
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(100);
            const first = await focused(page);
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(100);
            const second = await focused(page);
            await page.keyboard.press('Escape');
            const closed = await gone(page.getByRole('menu'), 3000);
            const back = await focusUntil(page, /Menu/, focused);
            return {
              pass:
                answered === 'deleted' &&
                menuShown &&
                /^menuitem|^menu /.test(reopened) &&
                first !== second &&
                /^menuitem/.test(first) &&
                /^menuitem/.test(second) &&
                closed &&
                back === 'button "Menu"' &&
                (how !== 'keyboard' || returned === 'button "Menu"'),
              answered,
              duringExit,
              returned,
              menuShown,
              reopened,
              arrows: [first, second],
              closed,
              back,
            };
          }),
        );
      }
    // Ordinary dismissal keeps the menu's exit animation.
    results.push(
      await attemptOn(errors, 'menu-dialog-plain-exit', async () => {
        await page.emulateMedia({ colorScheme: null });
        await page.goto(origin + '/?screen=menu-confirm');
        await menu.click();
        await page.getByRole('menuitem', { name: 'Rename list' }).waitFor();
        await settle(page);
        const exits = [];
        for (const close of ['Escape', 'action']) {
          if (close === 'action') {
            await menu.click();
            await page.getByRole('menuitem', { name: 'Rename list' }).waitFor();
            await settle(page);
          }
          const popover = page.locator('[data-slot=dropdown-menu-content]');
          const animated = popover.evaluate(
            (el) =>
              new Promise((done) => {
                const seen = () =>
                  el.hasAttribute('data-exiting') &&
                  el.getAnimations().length > 0;
                if (seen()) return done(true);
                const observer = new MutationObserver(() => {
                  if (!seen()) return;
                  observer.disconnect();
                  done(true);
                });
                observer.observe(el, { attributes: true });
                setTimeout(() => done(false), 3000);
              }),
          );
          if (close === 'Escape') await page.keyboard.press('Escape');
          else
            await page.getByRole('menuitem', { name: 'Rename list' }).click();
          exits.push({ close, animated: await animated });
          await gone(page.getByRole('menu'));
        }
        return { pass: exits.every((e) => e.animated), exits };
      }),
    );
  } finally {
    await page.emulateMedia({ colorScheme: null });
    results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
    await context.close();
  }
  return results;
}

export const suites = {
  contexts,
  contextQualifiers,
  gate,
  roundtrip,
  interaction,
  integration,
  contrast,
  routing,
  theme,
  compact,
  insets,
  workspace,
  search,
  accessSettings,
  startup,
  addPod,
  checkbox,
  confirmation,
  menuDialog,
  viewTabs,
  viewStrip,
  ghost,
};

/** The shipped chooser, with two fixture Pods and SDK draft guards. */
async function contexts({ browser, origin }) {
  const { context, page, errors } = await newPage(browser, {
    viewport: { width: 375, height: 812 },
  });
  let failed = false;
  let emptyBob = false;
  await page.route('**/_system/contexts', async (route) => {
    if (failed && route.request().url().includes('/bob/'))
      return route.fulfill({ status: 503, body: '{}' });
    const response = await route.fetch();
    const body = await response.json();
    body['https://schema.sempods.org/writableContext'] = body[
      'https://schema.sempods.org/writableContext'
    ].filter((c) => c['@id'].endsWith('/work'));
    if (emptyBob && route.request().url().includes('/bob/')) {
      body['http://www.w3.org/ns/sparql-service-description#namedGraph'] = [];
      body['https://schema.sempods.org/readableContext'] = [];
      body['https://schema.sempods.org/writableContext'] = [];
    }
    await route.fulfill({ json: body });
  });
  await page.route('**/_system/contexts/*', (route) => {
    const iri = route.request().url();
    const label = iri.endsWith('/work')
      ? 'Einkaufsliste'
      : '夏の買い物 / Dinge für die nächste gemeinsame Reise'.repeat(2);
    return route.fulfill({
      json: {
        '@id': iri,
        '@type': ['http://www.w3.org/ns/sparql-service-description#NamedGraph'],
        'http://www.w3.org/ns/sparql-service-description#name': [
          { '@id': iri },
        ],
        'https://schema.sempods.org/public': [{ '@value': false }],
        'http://www.w3.org/2000/01/rdf-schema#label': [{ '@value': label }],
      },
    });
  });
  const trigger = () => page.getByRole('button', { name: /^List:/ });
  const results = [];
  // The step that runs, so that a timeout names the wait it ended in.
  let step = 'sign-in';
  try {
    await signIn(page, origin, '/?screen=contexts&lang=de', { choose: false });
    await page
      .getByRole('button', { name: 'List: Einkaufsliste · Privat' })
      .waitFor();
    const mark = trigger().getByText('K', { exact: true });
    const markBox = await mark.locator('..').boundingBox();
    const singleTitle = await trigger()
      .getByText('Einkaufsliste', { exact: true })
      .boundingBox();
    const singleMark = await mark.boundingBox();
    await page.getByRole('button', { name: 'Connect second Pod' }).click();
    await page
      .getByRole('button', { name: 'List: Einkaufsliste · Familie/' })
      .waitFor();
    const doubleMark = await mark.boundingBox();
    const title = await trigger()
      .getByText('Einkaufsliste', { exact: true })
      .boundingBox();
    const subtitle = await trigger()
      .getByText('Familie/', { exact: true })
      .boundingBox();
    const singleCenterOffset =
      singleMark.y +
      singleMark.height / 2 -
      (singleTitle.y + singleTitle.height / 2);
    const lineGap = subtitle.y - (title.y + title.height);
    const chevron = await trigger().locator('svg').boundingBox();
    const titleCenter = title.y + title.height / 2;
    const chevronCenter = chevron.y + chevron.height / 2;
    const gap = chevron.x - (title.x + title.width);
    results.push({
      id: 'trigger-title-layout',
      pass:
        singleMark.height === doubleMark.height &&
        markBox.height >= 40 &&
        Math.abs(singleCenterOffset) <= 1 &&
        Math.abs(lineGap) <= 0.5 &&
        Math.abs(chevronCenter - titleCenter) <= 1 &&
        gap >= 0 &&
        gap <= 8,
      markBox,
      singleMark,
      doubleMark,
      singleCenterOffset,
      lineGap,
      gap,
      titleCenter,
      chevronCenter,
    });
    for (const scheme of ['light', 'dark']) {
      step = `grouped-${scheme}`;
      await page.emulateMedia({ colorScheme: scheme });
      await trigger().focus();
      await page.keyboard.press('Enter');
      const rows = page.getByRole('menuitemradio');
      await rows.first().waitFor();
      const geometry = await rows.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { height: r.height, left: r.left, right: r.right };
        }),
      );
      const rect = await trigger().boundingBox();
      // Only the two read-only rows carry a visible mark (#365); there is no
      // legend, address disclosure or sharing while every Pod shares lists.
      const marks = page.getByText('Nur lesen', { exact: true });
      const marked = await marks.evaluateAll((els) =>
        els.map((el) => ({
          row: el.closest('[role=menuitemradio]')?.textContent,
          hidden: el.getAttribute('aria-hidden'),
          right: el.getBoundingClientRect().right,
        })),
      );
      results.push({
        id: `grouped-${scheme}`,
        pass:
          (await rows.count()) === 4 &&
          (await page
            .getByRole('menuitemradio', { name: 'Einkaufsliste', exact: true })
            .count()) === 2 &&
          geometry.every(
            (r) => r.height >= 44 && r.left >= 0 && r.right <= 375,
          ) &&
          rect.height >= 64 &&
          marked.length === 2 &&
          marked.every(
            (m) =>
              m.row && !m.row.startsWith('Einkaufsliste') && m.right <= 375,
          ) &&
          (await page
            .getByText('Lesen und schreiben', { exact: true })
            .count()) === 0 &&
          (await page.getByRole('menuitem').count()) === 0 &&
          (await page.getByRole('region').count()) === 0,
        geometry,
        marked,
      });
      await page.addScriptTag({ content: contrastScript });
      const failing = await page
        .locator('[role="dialog"]:has([role="menu"])')
        .evaluate((el) => window.uiContrast(el).filter((r) => !r.pass));
      results.push({
        id: `grouped-contrast-${scheme}`,
        pass: failing.length === 0,
        failing,
      });
      step = `escape-${scheme}`;
      await page.keyboard.press('Escape');
      await page.waitForFunction(() =>
        document.activeElement?.getAttribute('aria-label')?.startsWith('List:'),
      );
      results.push({
        id: `escape-${scheme}`,
        pass: await trigger().evaluate((el) => el === document.activeElement),
      });
    }
    // Contrast, keyboard navigation and selection are checked above. Verify
    // the hierarchy as rendered by the packed CSS, including the portal.
    for (const width of [375, 960]) {
      await page.setViewportSize({ width, height: 812 });
      for (const rootSize of [16, 18]) {
        for (const dir of ['ltr', 'rtl']) {
          await page.evaluate((size) => {
            document.documentElement.style.fontSize = size + 'px';
          }, rootSize);
          await page
            .getByRole('checkbox', { name: 'Right-to-left layout' })
            .setChecked(dir === 'rtl');
          await trigger().click();
          const menu = page.getByRole('menu');
          await menu.waitFor();
          const measured = await menu.evaluate((el, dir) => {
            const edge = dir === 'ltr' ? 'left' : 'right';
            const sign = dir === 'ltr' ? 1 : -1;
            return Array.from(el.querySelectorAll('[role=group]'), (group) => {
              const heading = group.querySelector(
                '[data-slot=dropdown-menu-label]',
              );
              const range = document.createRange();
              range.selectNodeContents(heading);
              const headingEdge = range.getBoundingClientRect()[edge];
              return Array.from(
                group.querySelectorAll('[role=menuitemradio]'),
                (row) => {
                  const label = row.querySelector('[slot=label]');
                  const badge = row.querySelector('[data-slot=badge]');
                  const indicator = row.querySelector(
                    '[data-slot=dropdown-menu-radio-item-indicator]',
                  );
                  const preceding = (badge ?? label).getBoundingClientRect();
                  const check = indicator.getBoundingClientRect();
                  return {
                    height: row.getBoundingClientRect().height,
                    short: label.textContent === 'Einkaufsliste',
                    indent:
                      sign *
                      (label.getBoundingClientRect()[edge] - headingEdge),
                    trailingGap:
                      dir === 'ltr'
                        ? check.left - preceding.right
                        : preceding.left - check.right,
                  };
                },
              );
            }).flat();
          }, dir);
          const groupGap = await menu
            .getByRole('group')
            .evaluateAll(
              ([first, second]) =>
                second.getBoundingClientRect().top -
                first.getBoundingClientRect().bottom,
            );
          results.push({
            id: `context-layout-${width}-${rootSize}-${dir}`,
            groupGap,
            pass:
              groupGap >= rootSize / 2 - 1 &&
              measured.length === 4 &&
              measured.every(
                (row) =>
                  Math.abs(row.indent - rootSize / 2) < 1 &&
                  row.trailingGap >= 0 &&
                  (row.short
                    ? Math.abs(row.height - rootSize * 2.75) < 1
                    : row.height >= rootSize * 2.75),
              ),
            measured,
          });
          await page.keyboard.press('Escape');
        }
      }
    }
    await page
      .getByRole('checkbox', { name: 'Right-to-left layout' })
      .uncheck();
    await page.evaluate(() =>
      document.documentElement.style.removeProperty('font-size'),
    );
    step = 'keyboard-reaches-last-row';
    // A short phone viewport: the long names wrap and the popup scrolls.
    await page.setViewportSize({ width: 375, height: 400 });
    await trigger().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitemradio').first().waitFor();
    await settle(page);
    await page.keyboard.press('End');
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('[role=menuitemradio]');
      const last = rows[rows.length - 1];
      const popup = last?.closest('[role="dialog"]');
      if (!last || !popup || document.activeElement !== last) return false;
      const r = last.getBoundingClientRect(),
        p = popup.getBoundingClientRect();
      return (
        r.bottom <= Math.min(p.bottom, innerHeight) + 1 &&
        r.top >= Math.max(p.top, 0)
      );
    });
    results.push({ id: 'keyboard-reaches-last-row', pass: true });
    step = 'declined-cross-pod-draft';
    await page.keyboard.press('Escape');
    await page.waitForFunction(() =>
      document.activeElement?.getAttribute('aria-label')?.startsWith('List:'),
    );
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: 'Keep a draft' }).click();
    await trigger().click();
    await page
      .getByRole('menuitemradio', { name: 'Einkaufsliste', exact: true })
      .filter({ hasText: 'Privat ·' })
      .click();
    await page
      .getByRole('button', { name: 'Weiter bearbeiten', exact: true })
      .click();
    results.push({
      id: 'declined-cross-pod-draft',
      pass:
        (await page.getByLabel('target').textContent()).includes('/bob/') &&
        (await page.getByLabel('draft').textContent()) === 'dirty',
    });
    step = 'accepted-cross-pod-draft';
    await trigger().click();
    await page
      .getByRole('menuitemradio', { name: 'Einkaufsliste', exact: true })
      .filter({ hasText: 'Privat ·' })
      .click();
    await page
      .getByRole('button', { name: /Verwerfen und fortfahren/i })
      .click();
    results.push({
      id: 'accepted-cross-pod-draft',
      pass:
        (await page.getByLabel('target').textContent()).includes('/alice/') &&
        (await page.getByLabel('draft').textContent()) === 'clean',
    });
    step = 'partial-failure';
    failed = true;
    await page.getByRole('button', { name: 'Reload second Pod' }).click();
    await trigger().click();
    await page.getByText('Kontexte konnten nicht geladen werden.').waitFor();
    results.push({
      id: 'partial-failure',
      pass:
        (await page.getByRole('menuitemradio', { disabled: true }).count()) ===
          2 &&
        (await page.getByRole('menuitemradio', { disabled: false }).count()) ===
          2,
    });
    step = 'per-pod-retry';
    failed = false;
    await page.getByRole('menuitem', { name: /Familie/ }).click();
    await page
      .getByText('Kontexte konnten nicht geladen werden.')
      .waitFor({ state: 'hidden' });
    await page.waitForFunction(
      () => !document.querySelector('[role=menuitemradio][aria-disabled=true]'),
    );
    results.push({
      id: 'per-pod-retry',
      pass:
        (await page.getByRole('menuitemradio', { disabled: true }).count()) ===
        0,
    });
    step = 'read-only-target';
    await page
      .getByRole('menuitemradio')
      .filter({ hasText: 'Familie/ · Nur lesen' })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label=target]')
        ?.textContent?.endsWith('/bob/_system/contexts/personal'),
    );
    results.push({
      id: 'read-only-target',
      pass: (await page.getByLabel('target').textContent()).endsWith(
        '/personal',
      ),
    });
    step = 'one-group-per-ready-or-empty-pod';
    await trigger().click();
    await page
      .getByRole('menuitemradio', { name: 'Einkaufsliste', exact: true })
      .filter({ hasText: 'Privat ·' })
      .click();
    await page
      .getByRole('button', {
        name: 'List: Einkaufsliste · Privat',
        exact: true,
      })
      .waitFor();
    emptyBob = true;
    await page.getByRole('button', { name: 'Reload second Pod' }).click();
    await trigger().click();
    await page.getByText('Keine lesbaren Kontexte freigegeben.').waitFor();
    const groups = page.getByRole('group');
    results.push({
      id: 'one-group-per-ready-or-empty-pod',
      pass:
        (await groups.count()) === 2 &&
        (await page
          .getByRole('group', { name: 'Familie/', exact: true })
          .count()) === 1,
    });
    const share = page.getByRole('menuitem', {
      name: 'Kontexte freigeben …: Familie/',
      exact: true,
    });
    step = 'empty-pod-sharing-keeps-declined-draft';
    // A dirty draft must still guard sharing on the inactive empty Pod.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Keep a draft' }).click();
    await trigger().click();
    await share.click();
    await page
      .getByRole('button', { name: 'Weiter bearbeiten', exact: true })
      .click();
    results.push({
      id: 'empty-pod-sharing-keeps-declined-draft',
      pass:
        (await page.getByLabel('target').textContent()).includes('/alice/') &&
        (await page.getByLabel('draft').textContent()) === 'dirty',
    });
    step = 'share-empty-inactive-pod';
    await trigger().click();
    await share.click();
    emptyBob = false;
    const authorization = page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith('/_system/auth/authorize'),
    );
    await page
      .getByRole('button', { name: 'Verwerfen und fortfahren', exact: true })
      .click();
    const requested = await authorization;
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="target"]')
        ?.textContent.includes('/bob/'),
    );
    results.push({
      id: 'share-empty-inactive-pod',
      pass: new URL(requested.url()).pathname === '/bob/_system/auth/authorize',
    });
  } catch (error) {
    results.push({
      id: 'chooser-journey',
      pass: false,
      step,
      error: String(error),
      details: await page.evaluate(() => {
        const rows = document.querySelectorAll('[role=menuitemradio]');
        const last = rows[rows.length - 1];
        const popup = last?.closest('[role="dialog"]');
        return {
          viewport: { width: innerWidth, height: innerHeight },
          popup: popup && {
            ...popup.getBoundingClientRect().toJSON(),
            scroll: popup.scrollTop,
            scrollHeight: popup.scrollHeight,
            clientHeight: popup.clientHeight,
          },
          focus: document.activeElement?.outerHTML.slice(0, 250),
          items: Array.from(document.querySelectorAll('[role="menuitem"]')).map(
            (el) => ({
              text: el.textContent,
              label: el.getAttribute('aria-label'),
              labelledBy: el.getAttribute('aria-labelledby'),
            }),
          ),
          last: last?.getBoundingClientRect().toJSON(),
        };
      }),
    });
  }
  results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
  await context.close();
  return results;
}

/**
 * The ghost variant without a host reset (#392) on `?screen=ghost`: a
 * Button, an icon LinkButton, an ActionButton and HeaderMenu's button rest
 * without a surface under the reference screen's Tailwind and under a host
 * without Preflight (no-preflight.css, where a native button keeps its
 * face), in light and dark. At rest, hovered, focused by keyboard and, for
 * the menu, open, they paint the same surface, outline and ring under both
 * hosts, also in forced colors; hovered and open they take a surface.
 */
async function ghost({ browser, origin, engine }) {
  const { context, page, errors } = await newPage(browser, {
    reducedMotion: 'reduce',
  });
  const tab = tabKey(engine);
  const names = ['Ghost button', 'Ghost link', 'Ghost action', 'Ghost menu'];
  const target = (name) =>
    page.getByRole(name === 'Ghost link' ? 'link' : 'button', {
      name,
      exact: true,
    });
  const clear = (color) =>
    /^(rgba\(\d+, \d+, \d+, 0\)|transparent)$/.test(color);
  const paint = (locator) =>
    locator.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        background: s.backgroundColor,
        outline:
          s.outlineStyle === 'none'
            ? 'none'
            : `${s.outlineWidth} ${s.outlineStyle} ${s.outlineOffset}`,
        outlineColor: s.outlineStyle === 'none' ? 'none' : s.outlineColor,
        shadow: s.boxShadow,
        color: s.color,
      };
    });
  /** Loads the screen with the app's stylesheet or the host's without Preflight. */
  const load = async (host) => {
    await page.goto(origin + '/?screen=ghost');
    await target('Ghost menu').waitFor();
    if (host === 'none')
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const link = document.querySelector('link[rel=stylesheet]');
            link.addEventListener('load', resolve, { once: true });
            link.addEventListener('error', reject, { once: true });
            link.setAttribute('href', '/no-preflight.css');
          }),
      );
    await settle(page);
  };
  const modes = {
    light: { colorScheme: 'light', forcedColors: 'none' },
    dark: { colorScheme: 'dark', forcedColors: 'none' },
    forced: { colorScheme: 'light', forcedColors: 'active' },
  };
  const seen = {};
  const results = [];
  try {
    for (const [mode, media] of Object.entries(modes)) {
      await page.emulateMedia(media);
      for (const host of ['app', 'none']) {
        await load(host);
        const look = { native: await paint(page.locator('#native-button')) };
        for (const name of names)
          look[name] = { rest: await paint(target(name)) };
        // Keyboard focus from the start of the page, in tab order.
        for (const name of names) {
          await page.keyboard.press(tab);
          await settle(page);
          look[name].focus = {
            focused: await target(name).evaluate(
              (el) => el === document.activeElement,
            ),
            ...(await paint(target(name))),
          };
        }
        await page.keyboard.press('Enter');
        await page.getByRole('menu').waitFor();
        await settle(page);
        look['Ghost menu'].open = await paint(target('Ghost menu'));
        await page.keyboard.press('Escape');
        await hidden(page.getByRole('menu'));
        // The menu hands the focus back to its button after it closes; the
        // blur waits for that, so no focus outline is left for the hover.
        await focusUntil(page, /Ghost menu/);
        await page.evaluate(() => document.activeElement?.blur());
        await focusUntil(page, /^body$/);
        for (const name of names) {
          await target(name).hover();
          await settle(page);
          look[name].hover = await paint(target(name));
        }
        await page.mouse.move(1, 1);
        seen[`${mode}-${host}`] = look;
      }
    }
    await page.emulateMedia({ colorScheme: null, forcedColors: null });
    const states = (name) =>
      name === 'Ghost menu'
        ? ['rest', 'focus', 'open', 'hover']
        : ['rest', 'focus', 'hover'];
    for (const [mode, media] of Object.entries(modes)) {
      const forced = media.forcedColors === 'active';
      // What a host's reset decides: the surface, the outline and the ring.
      // In forced colors Firefox draws a link's outline in its text colour,
      // which a host without Preflight leaves as the browser's link colour.
      const drawn = ({ background, outline, outlineColor, shadow }) =>
        JSON.stringify({
          background,
          outline,
          shadow,
          ...(forced ? {} : { outlineColor }),
        });
      const app = seen[`${mode}-app`];
      const none = seen[`${mode}-none`];
      results.push({
        id: `ghost-without-preflight-${mode}`,
        pass:
          // Without Preflight a native button keeps its face.
          (forced ||
            (clear(app.native.background) && !clear(none.native.background))) &&
          names.every(
            (name) =>
              states(name).every(
                (state) => drawn(app[name][state]) === drawn(none[name][state]),
              ) &&
              [app, none].every(
                (look) =>
                  look[name].focus.focused &&
                  look[name].focus.outline !== 'none' &&
                  (forced ||
                    (clear(look[name].rest.background) &&
                      !clear(look[name].hover.background) &&
                      (name !== 'Ghost menu' ||
                        !clear(look[name].open.background)))),
              ),
          ),
        app,
        none,
      });
    }
  } finally {
    results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
    await context.close();
  }
  return results;
}
