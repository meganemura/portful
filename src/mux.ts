import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './config.ts';

const execFileAsync = promisify(execFile);

export interface MuxOpenOptions {
  /** Human-readable label for the new tab/window/pane. */
  title: string;
  /** Full shell command to run inside it. */
  command: string;
  cwd?: string;
  /**
   * This row's index in `wtshunt ui`'s flat row list (`buildRows`), so an
   * adapter that can control pane placement (currently only herdr) can lay
   * panes out to match the list's top-to-bottom order regardless of which
   * order rows are actually opened in. Adapters that can't control
   * placement (template/cmux/tmux/fallback) ignore it.
   */
  order?: number;
}

/**
 * A pluggable "open a labeled pane/tab/window running a command" adapter.
 * `wtshunt ui` uses this to launch `serve`/`proxy` externally, in a new
 * pane — never in-process — so they stay the same kind of foreground
 * process `wtshunt serve`/`wtshunt proxy` always have been.
 */
export interface Mux {
  name: string;
  detect(): boolean;
  open(options: MuxOpenOptions): Promise<void>;
}

/** Shell-quotes `value` for safe embedding in a `sh -c` command line. */
export function shQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_/:=.@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Restricts a title/label to characters safe for tmux window names and herdr agent names. */
function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9_./-]/g, '-');
  return cleaned.length > 0 ? cleaned : 'wtshunt';
}

/** True if `bin` resolves to an executable file somewhere on `$PATH`. */
function isBinOnPath(bin: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * `tmux new-window`/`herdr pane split`/`herdr tab create` all spawn the new
 * pane's shell with the multiplexer server's own stored environment, not
 * this process's — so
 * a custom `XDG_CONFIG_HOME`/`XDG_STATE_HOME` set only for this invocation
 * (rather than sourced by the user's shell rc files) would otherwise
 * silently fall back to the default paths in the new pane. Forwarded
 * explicitly via each adapter's own `-e`/`--env` flag so `serve`/`proxy`
 * always see the same config/state this `wtshunt ui` process resolved.
 */
function envForwardArgs(flag: string): string[] {
  const args: string[] = [];
  for (const name of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME']) {
    const value = process.env[name];
    if (value !== undefined) {
      args.push(flag, `${name}=${value}`);
    }
  }
  return args;
}

/** Absolute path to wtshunt's own executable, so opened panes don't depend on `$PATH`. */
export function wtshuntBinPath(): string {
  return resolve(process.argv[1] ?? 'wtshunt');
}

/** Builds `node <wtshunt-bin> <args...>`, fully shell-quoted, for use as a `Mux.open` command. */
export function wtshuntCommand(...args: string[]): string {
  return [shQuote(process.execPath), shQuote(wtshuntBinPath()), ...args.map(shQuote)].join(' ');
}

/** Substitutes `{title}`, `{cmd}`, and `{cwd}` into a `[ui] open` template, each shell-quoted. */
export function renderTemplate(template: string, options: MuxOpenOptions): string {
  return template
    .replaceAll('{title}', shQuote(options.title))
    .replaceAll('{cmd}', shQuote(options.command))
    .replaceAll('{cwd}', shQuote(options.cwd ?? process.cwd()));
}

/** Priority 1: a user-configured `[ui] open = "..."` shell template. */
export function templateMux(template: string): Mux {
  return {
    name: 'template',
    detect: () => true,
    async open(options) {
      const rendered = renderTemplate(template, options);
      await execFileAsync('sh', ['-c', rendered]);
    },
  };
}

export interface HerdrMuxOptions {
  /** Overrides the binary invoked for every herdr subcommand this adapter runs (`pane list`, `pane split`, `pane rename`, `pane run`, `pane layout`, `pane get`, `tab list`, `tab create`) — for tests only, so the real `herdr` is never exercised. */
  herdrBin?: string;
}

/**
 * One entry of `herdr pane list`'s `.result.panes[]`, as much of it as this
 * module cares about. `tab_id` (confirmed present by hands-on testing) is
 * only used by the plugin-mode dedicated-tab flow (see `herdrMux`'s doc
 * comment) to tell which of the listed panes belong to the "wtshunt" tab;
 * the ordinary flow ignores it.
 */
interface HerdrPane {
  pane_id: string;
  tab_id?: string;
}

function isHerdrPane(value: unknown): value is HerdrPane {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as { pane_id?: unknown; tab_id?: unknown };
  if (typeof v.pane_id !== 'string') {
    return false;
  }
  return v.tab_id === undefined || typeof v.tab_id === 'string';
}

/** One entry of `herdr tab list`'s `.result.tabs[]`, as much of it as this module cares about. */
interface HerdrTab {
  tab_id: string;
  label?: string;
}

function isHerdrTab(value: unknown): value is HerdrTab {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as { tab_id?: unknown; label?: unknown };
  if (typeof v.tab_id !== 'string') {
    return false;
  }
  return v.label === undefined || typeof v.label === 'string';
}

/**
 * One entry of `herdr pane layout`'s `.result.layout.panes[]`, as much of it
 * as this module cares about. `rect.y` (confirmed present alongside `rect.x`
 * by hands-on testing) is what the dedicated "wtshunt" tab's layout logic
 * uses to tell the ui pane's row (smallest `y`) apart from the row of
 * serve/proxy panes below it (larger `y`) — `rect.x` alone (all this
 * interface carried before) can't distinguish "left of the ui pane" from
 * "below it".
 */
interface HerdrLayoutPane {
  pane_id: string;
  rect: { x: number; y: number };
}

function isHerdrLayoutPane(value: unknown): value is HerdrLayoutPane {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as { pane_id?: unknown; rect?: unknown };
  if (typeof v.pane_id !== 'string' || v.rect === null || typeof v.rect !== 'object') {
    return false;
  }
  const rect = v.rect as { x?: unknown; y?: unknown };
  return typeof rect.x === 'number' && typeof rect.y === 'number';
}

/**
 * Runs `herdr pane list` and returns `.result.panes[]`, or `undefined` if
 * the command fails, its stdout isn't JSON, or the shape doesn't match what
 * hands-on inspection confirmed (`{"result":{"panes":[{"pane_id":...},
 * ...]}}`). `undefined` is the "skip this step" signal used throughout
 * `herdrMux` below — never thrown, since a `pane list` hiccup should only
 * skip the anchor-cleanup step that calls it, not stop pane creation
 * (`pane split`/`tab create`) from still doing its job.
 */
async function herdrPaneList(herdrBin: string): Promise<HerdrPane[] | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin, ['pane', 'list']));
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout) as { result?: { panes?: unknown } };
    const panes = parsed.result?.panes;
    return Array.isArray(panes) ? panes.filter(isHerdrPane) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `herdr tab list --workspace <workspaceId>` and returns
 * `.result.tabs[]`, or `undefined` if the command fails or its stdout
 * doesn't parse as the expected shape (`{"result":{"tabs":[{"tab_id":...,
 * "label":...}, ...]}}`, confirmed by hands-on testing). `undefined` here is
 * the plugin-mode flow's own "can't be trusted" signal (see `herdrMux`'s doc
 * comment): unlike `herdrPaneList`, whose failure only skips a cleanup step,
 * a failed `tab list` makes the whole dedicated-tab flow fall back to the
 * ordinary split-off-the-anchor flow instead — there'd be no reliable way to
 * tell whether the "wtshunt" tab already exists.
 */
async function herdrTabList(herdrBin: string, workspaceId: string): Promise<HerdrTab[] | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin, ['tab', 'list', '--workspace', workspaceId]));
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout) as { result?: { tabs?: unknown } };
    const tabs = parsed.result?.tabs;
    return Array.isArray(tabs) ? tabs.filter(isHerdrTab) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `herdr pane layout --pane <paneId>` and returns
 * `.result.layout.panes[]` — confirmed by hands-on testing to be the full
 * layout of whichever tab `paneId` belongs to (every pane in that tab, not
 * just `paneId` itself), each entry carrying a `rect.x`/`rect.y` that can be
 * compared to find the leftmost pane, or to split the tab into rows. Returns
 * `undefined` on failure, same "skip this step" contract as
 * `herdrPaneList`/`herdrTabList` — only used by the dedicated "wtshunt" tab's
 * placement logic (`decideWtshuntTabPlacement`), which has its own further
 * fallback for when this comes back `undefined`.
 */
async function herdrPaneLayout(herdrBin: string, paneId: string): Promise<HerdrLayoutPane[] | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin, ['pane', 'layout', '--pane', paneId]));
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout) as { result?: { layout?: { panes?: unknown } } };
    const panes = parsed.result?.layout?.panes;
    return Array.isArray(panes) ? panes.filter(isHerdrLayoutPane) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `.result.pane` shape of `herdr pane get`, as much of it as this module
 * cares about — just the `label` a prior `pane rename` set (confirmed by
 * hands-on testing).
 */
function isHerdrPaneGetPane(value: unknown): value is { label?: string } {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as { label?: unknown };
  return v.label === undefined || typeof v.label === 'string';
}

/**
 * Runs `herdr pane get <paneId>` and returns `.result.pane.label`, or
 * `undefined` if the command fails, its stdout isn't JSON, the shape doesn't
 * match, or the pane simply has no label. Same "skip this step" `undefined`
 * contract as `herdrPaneList`/`herdrTabList`/`herdrPaneLayout` — used only by
 * `decideWtshuntTabPlacement` to check whether a candidate pane is the
 * dedicated tab's own ui pane (labeled `wtshunt-ui` by `createWtshuntTab`); a
 * lookup failure is treated exactly like an outright label mismatch by that
 * caller, since either way there's no confirmed ui pane to anchor on.
 */
async function herdrPaneGet(herdrBin: string, paneId: string): Promise<string | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin, ['pane', 'get', paneId]));
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout) as { result?: { pane?: unknown } };
    const pane = parsed.result?.pane;
    return isHerdrPaneGetPane(pane) ? pane.label : undefined;
  } catch {
    return undefined;
  }
}

/** Where a new pane lands relative to its anchor — see `herdrPaneSplit`'s doc comment. */
interface HerdrSplitPlacement {
  direction: 'right' | 'down';
  /**
   * Fraction of height/width the *anchor* pane keeps after the split
   * (confirmed by hands-on testing: `--direction down --ratio 0.3` leaves
   * the anchor pane above at 30% of the tab's height and the new pane below
   * with the remaining 70%). `undefined` omits `--ratio` entirely and lets
   * herdr split evenly — every plain `--direction right` split (the
   * overwhelming majority) does this; only the dedicated "wtshunt" tab's
   * ui-pane-stays-on-top split passes one.
   */
  ratio?: number;
}

/**
 * Runs `herdr pane split --pane <anchorPaneId> --direction <right|down>
 * --no-focus [--ratio <ratio>] [--cwd <cwd>] [--env K=V]...` and returns the
 * new pane's id, taken from `.result.pane.pane_id`. Confirmed by hands-on
 * testing: the new pane is created immediately right of (or below, for
 * `direction: 'down'`) `anchorPaneId` — never at an arbitrary position, and
 * never wherever the server's own focus happens to be — and `--no-focus`
 * keeps focus from moving to it. `--cwd`/`--env` apply to the new pane's own
 * shell, same as they would to a fresh terminal. `placement` defaults to a
 * plain even `right` split, which is all every caller except the dedicated
 * "wtshunt" tab's layout logic (`createWtshuntTab`/`decideWtshuntTabPlacement`)
 * ever needs.
 *
 * Unlike every other herdr helper in this module, this one throws (either
 * `execFileAsync`'s own rejection on a nonzero exit, or an explicit `Error`
 * if an exit-0 response is missing `pane_id`) instead of returning
 * `undefined` on failure — see `herdrMux`'s doc comment for why: without a
 * pane, there's nowhere for `serve`/`proxy` (or, for the dedicated tab's own
 * root pane, `wtshunt ui` itself) to run, so the caller has nothing useful to
 * do but let `wtshunt ui` surface the error.
 */
async function herdrPaneSplit(
  herdrBin: string,
  anchorPaneId: string,
  cwd: string | undefined,
  placement: HerdrSplitPlacement = { direction: 'right' }
): Promise<string> {
  const args = ['pane', 'split', '--pane', anchorPaneId, '--direction', placement.direction, '--no-focus'];
  if (placement.ratio !== undefined) {
    args.push('--ratio', String(placement.ratio));
  }
  if (cwd) {
    args.push('--cwd', cwd);
  }
  args.push(...envForwardArgs('--env'));
  const { stdout } = await execFileAsync(herdrBin, args);
  const parsed = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
  const paneId = parsed.result?.pane?.pane_id;
  if (typeof paneId !== 'string') {
    throw new Error(`herdr pane split did not return a pane_id: ${stdout}`);
  }
  return paneId;
}

/**
 * Fallback for when there's no anchor pane to split from at all (see
 * `herdrMux`'s doc comment). Runs `herdr tab create --workspace <id>
 * [--label <label>] --cwd <cwd> --env K=V... --no-focus` (`--workspace`
 * only when `HERDR_WORKSPACE_ID` is set; `--label` only when `label` is
 * given — the ordinary flow never passes one, only the plugin-mode
 * dedicated-tab flow does, to name it "wtshunt") and returns the new tab's
 * root pane id, taken from `.result.root_pane.pane_id`. That root pane runs
 * a plain shell (confirmed by hands-on testing), same as any other freshly
 * split/created pane, so it's used exactly like one. Same throw-on-failure
 * behavior as `herdrPaneSplit`, for the same reason.
 */
async function herdrTabCreate(herdrBin: string, cwd: string | undefined, label?: string): Promise<string> {
  const args = ['tab', 'create'];
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (workspaceId !== undefined) {
    args.push('--workspace', workspaceId);
  }
  if (label !== undefined) {
    args.push('--label', label);
  }
  if (cwd) {
    args.push('--cwd', cwd);
  }
  args.push(...envForwardArgs('--env'));
  args.push('--no-focus');
  const { stdout } = await execFileAsync(herdrBin, args);
  const parsed = JSON.parse(stdout) as { result?: { root_pane?: { pane_id?: unknown } } };
  const paneId = parsed.result?.root_pane?.pane_id;
  if (typeof paneId !== 'string') {
    throw new Error(`herdr tab create did not return a pane_id: ${stdout}`);
  }
  return paneId;
}

/**
 * Runs `herdr pane rename <paneId> <label>`, labeling the pane. Failure
 * (nonzero exit, or any other rejection) is swallowed: a missing label is
 * cosmetic, not worth failing the whole `open()` call over when the pane
 * itself was already created successfully.
 */
async function herdrPaneRename(herdrBin: string, paneId: string, label: string): Promise<void> {
  try {
    await execFileAsync(herdrBin, ['pane', 'rename', paneId, label]);
  } catch {
    // Cosmetic only — the pane still exists and can still run its command.
  }
}

/**
 * Runs `herdr pane run <paneId> <command>`, which types `command` into the
 * pane's shell followed by Enter (confirmed by hands-on testing: exit 0 and
 * empty stdout on success). Confirmed safe to call immediately after
 * `herdrPaneSplit`/`herdrTabCreate` with no delay in between — the pty's own
 * type-ahead buffer holds the keystrokes even if the shell isn't fully
 * ready yet, so nothing has ever been observed to get lost. Throws on
 * failure (propagating `execFileAsync`'s rejection), same "nothing useful
 * to do but surface it" reasoning as `herdrPaneSplit` — a pane that exists
 * but never got its command is as useless to the caller as no pane at all.
 */
async function herdrPaneRun(herdrBin: string, paneId: string, command: string): Promise<void> {
  await execFileAsync(herdrBin, ['pane', 'run', paneId, command]);
}

/**
 * The tracked pane whose order is the closest one below `order` (or, if
 * `order` is `undefined`, the highest tracked order) — `undefined` if
 * `openedPanes` holds nothing that qualifies. Shared by every `herdrMux`
 * flow: the ordinary split-off-the-last-pane flow anchors on this directly,
 * and both dedicated-tab flows (`placeInExistingPluginTab`,
 * `tryOpenFromInsideWtshuntTab`) try this first before falling back to
 * `decideWtshuntTabPlacement`'s own ui-pane-relative lookup.
 */
function pickTrackedAnchor(openedPanes: Map<number, string>, order: number | undefined): string | undefined {
  let anchorPaneId: string | undefined;
  let bestOrder = -Infinity;
  for (const [ord, paneId] of openedPanes) {
    const qualifies = order !== undefined ? ord < order : true;
    if (qualifies && ord > bestOrder) {
      bestOrder = ord;
      anchorPaneId = paneId;
    }
  }
  return anchorPaneId;
}

/**
 * Drops any pane in `openedPanes` no longer reported as live by `pane list`
 * (the user closed it, etc.) so it can never be picked as an anchor again.
 * A `pane list` failure only skips this cleanup — `openedPanes` is left as
 * whatever it already held. Returns the panes `pane list` reported (or
 * `undefined` on failure) so a caller that also needs the full list
 * (`placeInExistingPluginTab`'s own-tab lookup) doesn't have to call it
 * twice.
 */
async function cleanupTrackedPanes(herdrBin: string, openedPanes: Map<number, string>): Promise<HerdrPane[] | undefined> {
  const panes = await herdrPaneList(herdrBin);
  if (panes !== undefined) {
    const currentIds = new Set(panes.map((p) => p.pane_id));
    for (const [ord, paneId] of openedPanes) {
      if (!currentIds.has(paneId)) {
        openedPanes.delete(ord);
      }
    }
  }
  return panes;
}

/** Label the dedicated tab is created/looked up under (see `herdrMux`'s doc comment). */
const PLUGIN_TAB_LABEL = 'wtshunt';

/**
 * Label `createWtshuntTab` gives the dedicated tab's own `wtshunt ui` pane,
 * so later `open()` calls (in either plugin mode or tab-inner mode) can tell
 * it apart from the serve/proxy panes below it — see
 * `decideWtshuntTabPlacement`.
 */
const UI_PANE_LABEL = 'wtshunt-ui';

/** Where the next serve/proxy pane should land inside the dedicated "wtshunt" tab — see `decideWtshuntTabPlacement`. */
interface WtshuntTabPlacement {
  anchorPaneId: string;
  direction: 'right' | 'down';
  ratio?: number;
}

/** The pane with the smallest `rect.x` among `panes` — ties keep whichever came first. */
function leftmostPane(panes: HerdrLayoutPane[]): HerdrLayoutPane {
  return panes.reduce((leftmost, p) => (p.rect.x < leftmost.rect.x ? p : leftmost));
}

/**
 * Decides where the next serve/proxy pane goes inside the dedicated
 * "wtshunt" tab, given `layout` — that tab's full `pane layout` response
 * (`undefined` if the call itself failed). Shared by plugin mode
 * (`placeInExistingPluginTab`) and tab-inner mode
 * (`tryOpenFromInsideWtshuntTab`), which differ only in how they arrive at
 * `layout` and what `selfPaneId` is.
 *
 * The **ui pane** is identified as the pane in the smallest-`rect.y` row
 * (ties broken by smallest `rect.x` — confirmed by hands-on testing that a
 * lower `rect.y` means a higher row, and that `pane layout`'s `rect.x`/
 * `rect.y` reliably tell rows and columns apart, so the dedicated tab's
 * intended shape — [ui pane spanning the full width] on top, [serve/proxy
 * panes side by side] below — can be read straight back out of the layout),
 * confirmed via `pane get` reporting its label as `wtshunt-ui`
 * (`createWtshuntTab` sets it). When that lookup doesn't pan out — no label
 * match — `selfPaneId` (only set in tab-inner mode, where the caller's own
 * pane, `HERDR_PANE_ID`, is known to already be the tab's `wtshunt ui`; left
 * `undefined` in plugin mode, whose own pane is the unrelated overlay) is
 * tried next by looking it up directly in `layout`. Only once *both* come up
 * empty — or `layout` itself is `undefined`/empty — does this fall back to
 * `layoutFailureAnchorPaneId` with a plain rightward split: the same "just
 * pick *a* pane in the tab, leftmost if `pane layout` says so" behavior the
 * dedicated-tab flow has always had, now reserved for a tab that predates
 * the ui-pane convention or a `pane layout` call that failed outright.
 *
 * Once a ui pane is settled on: a pane already below it (`rect.y` greater)
 * means serve/proxy panes are already there, so the leftmost one of those is
 * split rightward, keeping the row lined up left-to-right same as the
 * ordinary flow's own list-order placement. An empty row below instead
 * splits the ui pane itself downward at `ratio: 0.3` — confirmed by hands-on
 * testing that the *anchor* side of a `--direction down --ratio` split (here,
 * the ui pane) is the side that keeps `ratio`, so the ui pane keeps 30% of
 * the tab's height and the first serve/proxy pane takes the remaining 70%.
 */
async function decideWtshuntTabPlacement(
  herdrBin: string,
  layout: HerdrLayoutPane[] | undefined,
  layoutFailureAnchorPaneId: string,
  selfPaneId: string | undefined
): Promise<WtshuntTabPlacement> {
  if (layout === undefined || layout.length === 0) {
    return { anchorPaneId: layoutFailureAnchorPaneId, direction: 'right' };
  }

  const topRowY = layout.reduce((minY, p) => Math.min(minY, p.rect.y), Infinity);
  const topRowCandidate = leftmostPane(layout.filter((p) => p.rect.y === topRowY));
  const candidateLabel = await herdrPaneGet(herdrBin, topRowCandidate.pane_id);

  const uiPane: HerdrLayoutPane | undefined =
    candidateLabel === UI_PANE_LABEL
      ? topRowCandidate
      : selfPaneId !== undefined
        ? layout.find((p) => p.pane_id === selfPaneId)
        : undefined;

  if (uiPane === undefined) {
    return { anchorPaneId: leftmostPane(layout).pane_id, direction: 'right' };
  }

  const belowUiPane = layout.filter((p) => p.rect.y > uiPane.rect.y);
  if (belowUiPane.length > 0) {
    return { anchorPaneId: leftmostPane(belowUiPane).pane_id, direction: 'right' };
  }

  return { anchorPaneId: uiPane.pane_id, direction: 'down', ratio: 0.3 };
}

/**
 * Splits `anchorPaneId` per `placement`, then renames and runs `command` in
 * the new pane, tracking it in `openedPanes` under `order` if given. Shared
 * by every dedicated-tab placement path (plugin mode, tab-inner mode, and
 * fresh-tab creation) — the ordinary flow below inlines the same three calls
 * itself, since it only ever needs the default rightward placement.
 */
async function splitRenameRun(
  herdrBin: string,
  anchorPaneId: string,
  placement: HerdrSplitPlacement,
  { title, command, cwd, order }: MuxOpenOptions,
  openedPanes: Map<number, string>
): Promise<void> {
  const newPaneId = await herdrPaneSplit(herdrBin, anchorPaneId, cwd, placement);
  await herdrPaneRename(herdrBin, newPaneId, sanitizeLabel(title));
  await herdrPaneRun(herdrBin, newPaneId, `exec ${command}`);
  if (order !== undefined) {
    openedPanes.set(order, newPaneId);
  }
}

/**
 * Creates the dedicated "wtshunt" tab from scratch: `herdr tab create
 * --label wtshunt --no-focus [--env K=V]...` (no `--cwd` — the ui pane's
 * `wtshunt ui` doesn't depend on which directory it starts in, unlike
 * `serve`/`proxy`), then labels its root pane `wtshunt-ui` and runs
 * `wtshunt ui` in it via `exec` (same "the command *is* the pane's root
 * process, so the pane closes when it exits" reasoning as every other pane
 * this module opens — here that means the ui pane closes, and takes the rest
 * of the tab with it, only if `wtshunt ui` itself is quit). The row's own
 * serve/proxy pane is then split off *that* root pane with `--direction down
 * --ratio 0.3`, so the ui pane keeps the top 30% and today's row lands
 * directly below it, and is renamed/run/tracked exactly like any other
 * placement (`splitRenameRun`).
 */
async function createWtshuntTab(herdrBin: string, openedPanes: Map<number, string>, options: MuxOpenOptions): Promise<void> {
  const rootPaneId = await herdrTabCreate(herdrBin, undefined, PLUGIN_TAB_LABEL);
  await herdrPaneRename(herdrBin, rootPaneId, UI_PANE_LABEL);
  await herdrPaneRun(herdrBin, rootPaneId, `exec ${wtshuntCommand('ui')}`);

  await splitRenameRun(herdrBin, rootPaneId, { direction: 'down', ratio: 0.3 }, options, openedPanes);
}

/**
 * Places `options` inside the dedicated "wtshunt" tab (`tabId`), which is
 * already known to exist. Tries `pickTrackedAnchor` first — same rule as the
 * ordinary flow, so a `wtshunt ui` session that has already placed panes in
 * this tab keeps stacking them left-to-right by `order`, and (confirmed by
 * the tests) never even calls `pane layout`/`pane get` to do it. Only when
 * nothing qualifies there does it look up the tab's own layout — one pane
 * belonging to `tabId` is picked out of `pane list`'s results as a jumping-
 * off point for `pane layout`, then `decideWtshuntTabPlacement` takes it from
 * there.
 *
 * Returns `false` if `pane list` reports no live panes for `tabId` at all —
 * a `tab list` just said it exists but that, by the time this asks, has
 * nothing left to split off (e.g. it was closed moments after `tab list`
 * ran). The caller treats that the same as the tab never having existed and
 * creates a fresh one.
 */
async function placeInExistingPluginTab(
  herdrBin: string,
  tabId: string,
  openedPanes: Map<number, string>,
  options: MuxOpenOptions
): Promise<boolean> {
  const panes = await cleanupTrackedPanes(herdrBin, openedPanes);

  const tracked = pickTrackedAnchor(openedPanes, options.order);
  if (tracked !== undefined) {
    await splitRenameRun(herdrBin, tracked, { direction: 'right' }, options, openedPanes);
    return true;
  }

  const tabPanes = (panes ?? []).filter((p) => p.tab_id === tabId);
  if (tabPanes.length === 0) {
    return false;
  }

  const layout = await herdrPaneLayout(herdrBin, tabPanes[0].pane_id);
  const placement = await decideWtshuntTabPlacement(herdrBin, layout, tabPanes[0].pane_id, undefined);
  await splitRenameRun(herdrBin, placement.anchorPaneId, placement, options, openedPanes);
  return true;
}

/**
 * Plugin-mode gate for `herdrMux.open()` (see `herdrMux`'s doc comment for
 * why this whole flow exists). Returns `false` when the dedicated-tab
 * bookkeeping can't be trusted — `HERDR_WORKSPACE_ID` isn't set, or `tab
 * list` itself failed — so the caller falls through to the ordinary
 * split-off-the-anchor flow exactly as if `HERDR_PLUGIN_ID` had never been
 * set. Returns `true` once it has fully placed and started the pane. Past
 * the gate, failures propagate instead of triggering a fallback:
 * `herdrPaneSplit`/`herdrTabCreate`/`herdrPaneRun` still throw on failure
 * here for the same reason they do in the ordinary flow — a pane that can't
 * be created or started leaves `wtshunt ui` with nothing useful to silently
 * paper over.
 */
async function tryOpenInPluginTab(herdrBin: string, openedPanes: Map<number, string>, options: MuxOpenOptions): Promise<boolean> {
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (workspaceId === undefined) {
    return false;
  }

  const tabs = await herdrTabList(herdrBin, workspaceId);
  if (tabs === undefined) {
    return false;
  }
  const existingTab = tabs.find((t) => t.label === PLUGIN_TAB_LABEL);

  if (existingTab === undefined) {
    await createWtshuntTab(herdrBin, openedPanes, options);
    return true;
  }

  const handled = await placeInExistingPluginTab(herdrBin, existingTab.tab_id, openedPanes, options);
  if (!handled) {
    // The tab `tab list` reported turned out to have no live panes by the
    // time `pane list` was asked — treat it the same as "no tab yet" rather
    // than splitting off nothing.
    await createWtshuntTab(herdrBin, openedPanes, options);
  }
  return true;
}

/**
 * Tab-inner-mode gate for `herdrMux.open()` (see `herdrMux`'s doc comment).
 * Unlike plugin mode, there's no separate overlay pane here — the process
 * calling `open()` is itself running as a pane inside some tab, and this
 * only proceeds when that tab *is* the dedicated "wtshunt" tab (checked via
 * `HERDR_TAB_ID` against `tab list --workspace <HERDR_WORKSPACE_ID>`'s own
 * `tab_id`s, since herdr doesn't expose a tab's own label any other way).
 * Returns `false` — falling through to the ordinary flow — when
 * `HERDR_TAB_ID`/`HERDR_WORKSPACE_ID` aren't set, `tab list` fails, or the
 * tab it finds isn't labeled `wtshunt`: none of those can happen for a
 * `wtshunt ui` opened via `createWtshuntTab`, but do for `wtshunt ui`
 * started directly in some unrelated tab.
 *
 * Once confirmed, this is `placeInExistingPluginTab`'s counterpart for a
 * tab that's already known to exist and need not be searched for via `pane
 * list`'s `tab_id` field: `pane layout` is queried directly off the caller's
 * own pane (`HERDR_PANE_ID`), and that same pane is passed to
 * `decideWtshuntTabPlacement` as `selfPaneId` — the fallback for when the
 * ui-pane label lookup doesn't land on a match, since a `wtshunt ui` running
 * inside the "wtshunt" tab *is* that tab's ui pane by construction, label or
 * not.
 */
async function tryOpenFromInsideWtshuntTab(
  herdrBin: string,
  openedPanes: Map<number, string>,
  options: MuxOpenOptions
): Promise<boolean> {
  const tabId = process.env.HERDR_TAB_ID;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (tabId === undefined || workspaceId === undefined) {
    return false;
  }

  const tabs = await herdrTabList(herdrBin, workspaceId);
  if (tabs === undefined) {
    return false;
  }
  const ownTab = tabs.find((t) => t.tab_id === tabId);
  if (ownTab === undefined || ownTab.label !== PLUGIN_TAB_LABEL) {
    return false;
  }

  await cleanupTrackedPanes(herdrBin, openedPanes);
  const tracked = pickTrackedAnchor(openedPanes, options.order);
  if (tracked !== undefined) {
    await splitRenameRun(herdrBin, tracked, { direction: 'right' }, options, openedPanes);
    return true;
  }

  const ownPaneId = process.env.HERDR_PANE_ID;
  if (ownPaneId === undefined) {
    // Shouldn't happen for a pane genuinely running inside a herdr tab, but
    // without it there's no anchor to fall back to either — let the caller
    // fall through to the ordinary flow instead of guessing.
    return false;
  }

  const layout = await herdrPaneLayout(herdrBin, ownPaneId);
  const placement = await decideWtshuntTabPlacement(herdrBin, layout, ownPaneId, ownPaneId);
  await splitRenameRun(herdrBin, placement.anchorPaneId, placement, options, openedPanes);
  return true;
}

/**
 * Priority 2: herdr, detected via `HERDR_ENV`/`HERDR_SOCKET_PATH`.
 *
 * herdr's own docs are explicit about which command family a process like
 * `wtshunt ui` should use here: "Use `herdr pane ...` commands for ordinary
 * terminals, servers, tests, shells, and low-level terminal input. For
 * example, use `pane split` and `pane run` for `cargo test`, not `agent
 * start`, unless that terminal is intentionally being treated as an agent
 * target." `serve`/`proxy` are exactly that kind of ordinary long-running
 * server process, not an agent — so this adapter opens panes with `pane
 * split` + `pane rename` + `pane run`, never `agent start`.
 *
 * That choice also removes a whole layer an earlier version of this
 * adapter needed: `agent start --split right` could only ever insert the
 * new pane immediately right of the tab's *current* pane, with no way to
 * name an arbitrary anchor, so lining panes up to match `wtshunt ui`'s own
 * list order (`MuxOpenOptions.order`) required `pane swap`-based
 * "bubbling" after the fact, plus a focus-restore walk to undo a side
 * effect of swapping. `pane split --pane <anchor>` takes the anchor
 * directly and (confirmed by hands-on testing) always inserts the new pane
 * immediately right of it, so list-order placement now falls out of
 * choosing the right anchor up front — no swapping, no focus ever moves,
 * nothing to restore.
 *
 * The anchor is chosen from `order` (this row's index in `wtshunt ui`'s
 * list) against `openedPanes`, a map of every order this adapter has
 * placed so far to the pane it landed in: the closest lower order's pane
 * if one exists, else `wtshunt ui`'s own pane (`HERDR_PANE_ID`). A row with
 * no `order` (e.g. a `toggle-proxy` open with no matching list row) is
 * anchored to the highest order seen so far, or also the ui pane if
 * nothing's been placed yet. Before choosing it, a single `pane list` call
 * drops any previously-tracked pane no longer reported as live (the user
 * closed it, etc.) so it can never be picked as an anchor again — if `pane
 * list` itself fails, only that cleanup is skipped; placement still
 * proceeds against whatever `openedPanes` already held.
 *
 * If there's no anchor at all — nothing tracked yet, and `HERDR_PANE_ID`
 * unset because this `wtshunt ui` wasn't itself started from a herdr pane
 * — there's nothing to split from, so this falls back to `herdrTabCreate`
 * instead, opening a fresh tab.
 *
 * Either way, a failure to create the pane (nonzero exit, or a response
 * missing the expected `pane_id`) is not swallowed: `herdrPaneSplit`/
 * `herdrTabCreate` throw, so `wtshunt ui` surfaces the error instead of
 * silently doing nothing. Without a pane there's nowhere for `serve`/
 * `proxy` to run — unlike, say, a failed `pane rename`, which only costs a
 * label and is swallowed instead (see `herdrPaneRename`).
 *
 * **Dedicated "wtshunt" tab (plugin mode and tab-inner mode).** `wtshunt`
 * also ships as a herdr plugin (`herdr-plugin.toml`) whose `ui` pane opens
 * `wtshunt ui` as an `overlay` — a pane that floats over whichever tab the
 * user was actually working in, rather than living inside it. Splitting off
 * that overlay pane (i.e. off `HERDR_PANE_ID` as usual) would therefore
 * insert the new `serve`/`proxy` pane into whatever tab happened to be
 * underneath, confirmed by hands-on testing to really happen: opening
 * `serve`/`proxy` from the overlay this way interrupts whatever the user was
 * actually looking at, exactly the scenario this adapter exists to give
 * panes a stable home outside of. So whenever this pane was started by herdr
 * as a plugin entrypoint — detected via `HERDR_PLUGIN_ID` being set in the
 * environment (herdr sets it, along with `HERDR_PLUGIN_ROOT`/
 * `HERDR_PLUGIN_ENTRYPOINT_ID`, only for plugin-pane commands; it's unset
 * for a `wtshunt ui` started directly in an ordinary pane) — `open()`
 * instead routes through `tryOpenInPluginTab`, which collects every
 * `serve`/`proxy` pane into one dedicated tab labeled "wtshunt" in the
 * current workspace (`HERDR_WORKSPACE_ID`), creating that tab on first use,
 * and never touches whichever tab the user is actually looking at.
 *
 * That dedicated tab is laid out with `wtshunt ui` itself pinned across the
 * top and every `serve`/`proxy` pane lined up side by side underneath, in
 * list order — see `decideWtshuntTabPlacement`/`createWtshuntTab` for the
 * mechanics. Two things motivate keeping `wtshunt ui` in the tab at all,
 * rather than only ever splitting bare serve/proxy panes off each other: a
 * tab whose only panes are `serve`/`proxy` disappears the moment the last of
 * them is stopped (nothing left running inside it), taking the whole tab —
 * and the user's place in it — down with it; and having `wtshunt ui` inside
 * the tab, not just the floating overlay, gives a second, persistent place
 * to drive `serve`/`proxy` from without needing the overlay keybinding at
 * all.
 *
 * That second entry point is **tab-inner mode**: a `wtshunt ui` started
 * directly inside a pane (`HERDR_PLUGIN_ID` unset, so plugin mode's own gate
 * never fires) still ends up placing panes into the same dedicated layout,
 * *if* the pane it's running in is itself inside the "wtshunt" tab already —
 * checked by `tryOpenFromInsideWtshuntTab` via `HERDR_TAB_ID`/
 * `HERDR_WORKSPACE_ID` against `tab list`'s own tab labels, since a plain
 * pane's env carries `HERDR_PANE_ID`/`HERDR_TAB_ID`/`HERDR_WORKSPACE_ID` but
 * never `HERDR_PLUGIN_ID` (confirmed by hands-on testing — that var really
 * is plugin-entrypoint-only). Pressing `s`/`p` inside a `wtshunt ui` that's
 * sitting in the top pane of its own "wtshunt" tab therefore lands the new
 * pane in the same bottom row a plugin-mode overlay would have used, instead
 * of splitting `wtshunt ui`'s own pane directly (which the ordinary flow
 * would otherwise do, since `HERDR_PANE_ID` would be the only anchor it
 * knows about).
 *
 * The ordinary flow below is unchanged and is what runs for a `wtshunt ui`
 * started directly in a pane outside of any "wtshunt" tab (no plugin
 * involved, tab-inner mode's own check declining), and is also what
 * `tryOpenInPluginTab`/`tryOpenFromInsideWtshuntTab` themselves fall back to
 * when their bookkeeping can't be trusted (see their doc comments).
 */
export function herdrMux(options: HerdrMuxOptions = {}): Mux {
  const herdrBin = options.herdrBin ?? 'herdr';
  const openedPanes = new Map<number, string>(); // order -> pane_id

  return {
    name: 'herdr',
    detect: () => Boolean(process.env.HERDR_ENV || process.env.HERDR_SOCKET_PATH),
    async open({ title, command, cwd, order }) {
      if (process.env.HERDR_PLUGIN_ID !== undefined) {
        const handled = await tryOpenInPluginTab(herdrBin, openedPanes, { title, command, cwd, order });
        if (handled) {
          return;
        }
        // HERDR_WORKSPACE_ID wasn't set, or `tab list` itself failed —
        // falls through to the ordinary flow below exactly as if
        // HERDR_PLUGIN_ID had never been set.
      } else {
        const handled = await tryOpenFromInsideWtshuntTab(herdrBin, openedPanes, { title, command, cwd, order });
        if (handled) {
          return;
        }
        // HERDR_TAB_ID/HERDR_WORKSPACE_ID weren't set, `tab list` itself
        // failed, or this pane's own tab isn't labeled "wtshunt" — falls
        // through to the ordinary flow below exactly as if tab-inner mode
        // had never been checked.
      }

      // Drop anything wtshunt placed previously that's no longer among the
      // live panes (the user closed it, etc.) so it never gets picked as an
      // anchor below. A `pane list` failure only skips this cleanup —
      // placement still proceeds against whatever `openedPanes` held.
      await cleanupTrackedPanes(herdrBin, openedPanes);

      const anchorPaneId = pickTrackedAnchor(openedPanes, order) ?? process.env.HERDR_PANE_ID;

      const newPaneId =
        anchorPaneId !== undefined
          ? await herdrPaneSplit(herdrBin, anchorPaneId, cwd)
          : await herdrTabCreate(herdrBin, cwd);

      await herdrPaneRename(herdrBin, newPaneId, sanitizeLabel(title));
      // `exec` replaces the pane's shell with the command, so the pane
      // closes when the server exits (confirmed by hands-on testing) instead
      // of dropping back to an idle shell that piles up across restarts.
      // This matches every other adapter, where the command *is* the pane's
      // root process.
      await herdrPaneRun(herdrBin, newPaneId, `exec ${command}`);

      if (order !== undefined) {
        openedPanes.set(order, newPaneId);
      }
    },
  };
}

export interface CmuxMuxOptions {
  /**
   * Overrides which binary name/path is both invoked and PATH-checked by
   * `detect()` — for tests only, so detection can be verified against a
   * harmless stand-in (e.g. `ls`, or a deliberately-missing name) without
   * depending on whether the real `cmux` happens to be installed, and
   * `open()` is never actually exercised against the real binary in tests.
   */
  cmuxBin?: string;
}

/**
 * Priority 3: cmux, a Ghostty-based terminal app whose CLI supports opening
 * a new workspace directly. Detected via `CMUX_SOCKET_PATH`/
 * `CMUX_WORKSPACE_ID` *and* the `cmux` binary being on `$PATH` — when the
 * user's own terminal is running inside cmux, this is the adapter that
 * actually matters in practice, ahead of tmux.
 */
export function cmuxArgs({ title, command, cwd }: MuxOpenOptions): string[] {
  const args = ['new-workspace', '--name', title];
  if (cwd) {
    args.push('--cwd', cwd);
  }
  // `new-workspace` is the only cmux subcommand that accepts name/cwd/command
  // together (confirmed via `cmux --help`) — `tab-action` and `new-surface`
  // don't take a --command. `--focus false` keeps it from stealing focus
  // from wtshunt ui's own screen.
  args.push('--command', command, '--focus', 'false');
  return args;
}

export function cmuxMux(options: CmuxMuxOptions = {}): Mux {
  const cmuxBin = options.cmuxBin ?? 'cmux';
  return {
    name: 'cmux',
    detect: () => Boolean((process.env.CMUX_SOCKET_PATH || process.env.CMUX_WORKSPACE_ID) && isBinOnPath(cmuxBin)),
    async open(muxOptions) {
      await execFileAsync(cmuxBin, cmuxArgs(muxOptions));
    },
  };
}

export interface TmuxMuxOptions {
  tmuxBin?: string;
  /** Overrides the tmux server socket (`tmux -L <name>`) — for tests only; real usage attaches to the ambient `$TMUX` server. */
  socketName?: string;
  /** Overrides the target session (`new-window -t <name>`) — for tests only; real usage defaults to the current session. */
  targetSession?: string;
}

/** Priority 4: tmux, detected via `$TMUX`. */
export function tmuxMux(options: TmuxMuxOptions = {}): Mux {
  const tmuxBin = options.tmuxBin ?? 'tmux';
  const socketArgs = options.socketName ? ['-L', options.socketName] : [];
  return {
    name: 'tmux',
    detect: () => Boolean(process.env.TMUX),
    async open({ title, command, cwd }) {
      const args = [...socketArgs, 'new-window'];
      if (options.targetSession) {
        args.push('-t', options.targetSession);
      }
      args.push('-n', sanitizeLabel(title));
      if (cwd) {
        args.push('-c', cwd);
      }
      args.push(...envForwardArgs('-e'));
      args.push(command);
      await execFileAsync(tmuxBin, args);
    },
  };
}

/** The message printed/returned by the fallback adapter, shared so `wtshunt ui` can show it without invoking `open`'s own console output. */
export function fallbackMessage({ title, command, cwd }: MuxOpenOptions): string {
  const cd = cwd ? `cd ${shQuote(cwd)} && ` : '';
  return `No multiplexer detected for "${title}" — run this in another terminal: ${cd}${command}`;
}

/** Priority 5: no multiplexer detected and no `[ui] open` template — print guidance instead of opening anything. */
export function fallbackMux(): Mux {
  return {
    name: 'fallback',
    detect: () => true,
    async open(options) {
      console.log(fallbackMessage(options));
    },
  };
}

/**
 * Picks the multiplexer adapter to use: an explicit `[ui] open` template
 * always wins, then herdr, then cmux, then tmux, then the plain-text
 * fallback.
 */
export function resolveMux(config: Config): Mux {
  if (config.ui?.open) {
    return templateMux(config.ui.open);
  }

  const herdr = herdrMux();
  if (herdr.detect()) {
    return herdr;
  }

  const cmux = cmuxMux();
  if (cmux.detect()) {
    return cmux;
  }

  const tmux = tmuxMux();
  if (tmux.detect()) {
    return tmux;
  }

  return fallbackMux();
}
