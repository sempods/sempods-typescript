/* global document, getComputedStyle, history, innerHeight, innerWidth, location, MutationObserver, requestAnimationFrame, window */
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
 * and the unchosen filter chip are also measured hovered and pressed; controls reached by Tab with their
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
              await page.goto(origin + '/' + query);
              await reach(page);
              await settle(page);
              const measured = await page.evaluate(() => window.uiContrast());
              const tagged = (list, suffix) =>
                list.map((m) => ({ ...m, what: `${m.what} ${suffix}` }));
              const pressed = {
                zen: ['Complete', 'Not today', 'Previous task'],
                list: ['All'],
              };
              for (const name of pressed[state] ?? []) {
                const target = page.getByRole(
                  state === 'list' ? 'radio' : 'button',
                  { name, exact: true },
                );
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
    // German: the corner Close takes the SDK's text.
    async 'compact-close-label-german'() {
      await open('de');
      const names = await dialog
        .locator('[data-slot=dialog-close]')
        .evaluateAll((buttons) => buttons.map((b) => b.textContent?.trim()));
      return { pass: names.join() === 'Schließen', names };
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
  const open = async ({ width = 1280, lang = 'en' } = {}) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(
      origin + `/?screen=search${lang === 'de' ? '&lang=de' : ''}`,
    );
    await field.waitFor();
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
  try {
    await signIn(page, origin, '/?screen=contexts&lang=de', { choose: false });
    await page
      .getByRole('button', { name: 'List: Einkaufsliste · Privat' })
      .waitFor();
    await page.getByRole('button', { name: 'Connect second Pod' }).click();
    await page
      .getByRole('button', { name: 'List: Einkaufsliste · Familie/' })
      .waitFor();
    for (const scheme of ['light', 'dark']) {
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
      results.push({
        id: `grouped-${scheme}`,
        pass:
          (await rows.count()) === 4 &&
          (await page
            .getByRole('menuitemradio', { name: 'Einkaufsliste', exact: true })
            .count()) === 2 &&
          geometry.every(
            (r) => r.height >= 52 && r.left >= 0 && r.right <= 375,
          ) &&
          rect.height >= 64 &&
          (await page
            .getByText('Lesen und schreiben', { exact: true })
            .count()) === 1,
        geometry,
      });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() =>
        document.activeElement?.getAttribute('aria-label')?.startsWith('List:'),
      );
      results.push({
        id: `escape-${scheme}`,
        pass: await trigger().evaluate((el) => el === document.activeElement),
      });
    }
    await page.setViewportSize({ width: 375, height: 400 });
    await trigger().click();
    await page
      .getByRole('menuitem', { name: 'Pod- und Kontextadressen anzeigen' })
      .focus();
    await page.keyboard.press('Enter');
    const addresses = page.getByRole('region', {
      name: 'Pod- und Kontextadressen',
      exact: true,
    });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('role') === 'region',
    );
    await page.keyboard.press('End');
    // Native scroll is animated on some engines: wait for the final address,
    // not merely for a rendered element below the viewport.
    await page.waitForFunction(() => {
      const region = document.querySelector('[role=region][tabindex="0"]');
      const last = region?.querySelector('dl:last-child dd:last-child');
      if (!region || !last) return false;
      const r = region.getBoundingClientRect(),
        d = last.getBoundingClientRect(),
        popup = region.closest('[role="dialog"]')?.getBoundingClientRect();
      return (
        d.bottom <=
          Math.min(r.bottom, popup?.bottom ?? innerHeight, innerHeight) + 1 &&
        d.top >= Math.max(r.top, popup?.top ?? 0, 0)
      );
    });
    results.push({
      id: 'address-keyboard-scroll',
      pass: await addresses.evaluate((el) => el === document.activeElement),
    });
    results.push({
      id: 'exact-address-details',
      pass:
        (await page
          .getByText(origin + '/alice', { exact: true })
          .isVisible()) &&
        (await page
          .locator('dd')
          .filter({ hasText: origin + '/bob/_system/contexts/work' })
          .isVisible()),
    });
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
      name: 'Weitere Kontexte freigeben …: Familie/',
      exact: true,
    });
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
      error: String(error),
      details: await page.evaluate(() => {
        const region = document.querySelector('[role=region][tabindex="0"]');
        const last = region?.querySelector('dl:last-child dd:last-child');
        return {
          focus: document.activeElement?.outerHTML.slice(0, 250),
          items: Array.from(document.querySelectorAll('[role="menuitem"]')).map(
            (el) => ({
              text: el.textContent,
              label: el.getAttribute('aria-label'),
              labelledBy: el.getAttribute('aria-labelledby'),
            }),
          ),
          region: region?.getBoundingClientRect().toJSON(),
          last: last?.getBoundingClientRect().toJSON(),
          scroll: region?.scrollTop,
          scrollHeight: region?.scrollHeight,
        };
      }),
    });
  }
  results.push({ id: 'no-page-errors', pass: errors.length === 0, errors });
  await context.close();
  return results;
}
