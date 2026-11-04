/**
 * Command registry. Menus, hotkeys, context menus and toolbar buttons are all driven from here,
 * so the integrator can wire a kernel op by registering (or re-registering) one command.
 *
 *   registerCommand({ id: 'dart.add', title: 'Add Dart…', menu: 'Dart', hotkey: 'Shift+D', run(ctx) {...} })
 *
 * Hotkeys: a default chord per command ("Ctrl+Shift+S", "Delete", "ArrowLeft"; several chords
 * separated by ","), user overrides in settings.hotkeys (editable as JSON). Meta is treated as Ctrl.
 */
import type { App } from './app';
import { settings } from './settings';
import { toast } from './ui/toast';
import { NotWiredError } from './ops-bridge';

export interface CommandCtx { app: App }

export interface Command {
  id: string;
  title: string;
  /** 'File' or nested 'File/Export'. Omit to keep the command off the menubar. */
  menu?: string;
  /** separator group within its menu; items sort by group then order */
  group?: number;
  order?: number;
  hotkey?: string;
  run(ctx: CommandCtx): void | Promise<void>;
  enabled?(ctx: CommandCtx): boolean;
  checked?(ctx: CommandCtx): boolean;
  /** hint shown in menus for stub commands etc. */
  hint?: string;
}

export const MENUS = ['File', 'Edit', 'Piece', 'Point', 'Segment', 'Seam', 'Dart', 'Grade', 'Measure', 'View', 'Help'] as const;

const registry = new Map<string, Command>();
let seq = 0;
const seqOf = new Map<string, number>();
let ctxRef: CommandCtx | null = null;
const listeners = new Set<() => void>();

export function setCommandContext(ctx: CommandCtx) { ctxRef = ctx; }
export function onCommandsChanged(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }

export function registerCommand(cmd: Command): Command {
  if (!seqOf.has(cmd.id)) seqOf.set(cmd.id, seq++);
  registry.set(cmd.id, cmd);
  for (const l of listeners) l();
  return cmd;
}
export function getCommand(id: string) { return registry.get(id); }
export function allCommands(): Command[] {
  return [...registry.values()].sort((a, b) => (seqOf.get(a.id)! - seqOf.get(b.id)!));
}
export function menuCommands(path: string): Command[] {
  return allCommands().filter(c => c.menu === path)
    .sort((a, b) => (a.group ?? 0) - (b.group ?? 0) || (a.order ?? 0) - (b.order ?? 0) || seqOf.get(a.id)! - seqOf.get(b.id)!);
}
/** direct sub-menus of a path (e.g. 'File' → ['File/Export', 'File/Import']) */
export function subMenus(path: string): string[] {
  const out: string[] = [];
  for (const c of allCommands()) {
    if (!c.menu || !c.menu.startsWith(path + '/')) continue;
    const rest = c.menu.slice(path.length + 1).split('/')[0];
    const sub = path + '/' + rest;
    if (!out.includes(sub)) out.push(sub);
  }
  return out;
}

export function isEnabled(c: Command): boolean {
  if (!ctxRef || !c.enabled) return true;
  try { return c.enabled(ctxRef); } catch { return false; }
}
export function isChecked(c: Command): boolean | undefined {
  if (!ctxRef || !c.checked) return undefined;
  try { return c.checked(ctxRef); } catch { return false; }
}

export async function runCommand(id: string): Promise<void> {
  const c = registry.get(id);
  if (!c || !ctxRef) { toast(`Unknown command ${id}`, 'error'); return; }
  if (!isEnabled(c)) return;
  try {
    await c.run(ctxRef);
  } catch (err) {
    reportError(err, c.title);
  }
  ctxRef.app.invalidate();
}

export function reportError(err: unknown, what: string) {
  if (err instanceof NotWiredError) { toast(`${what}: not wired yet (${err.module})`, 'warn', 3500); return; }
  console.error(err);
  toast(`${what}: ${(err as Error)?.message ?? String(err)}`, 'error', 4500);
}

// ───────────── hotkeys ─────────────

export function effectiveHotkey(id: string): string {
  const o = settings.hotkeys[id];
  if (o !== undefined) return o;
  return registry.get(id)?.hotkey ?? '';
}

export function normalizeChord(chord: string): string {
  const parts = chord.split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  let key = parts.pop()!;
  // "Ctrl++" style
  if (chord.trim().endsWith('++')) key = '+';
  const mods = new Set(parts.map(p => p.toLowerCase()));
  const m: string[] = [];
  if (mods.has('ctrl') || mods.has('cmd') || mods.has('meta') || mods.has('control')) m.push('Ctrl');
  if (mods.has('alt') || mods.has('option')) m.push('Alt');
  if (mods.has('shift')) m.push('Shift');
  const k = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  return [...m, k === 'Del' ? 'Delete' : k === 'Esc' ? 'Escape' : k === ' ' ? 'Space' : k].join('+');
}

export function chordFromEvent(e: KeyboardEvent): string {
  const m: string[] = [];
  if (e.ctrlKey || e.metaKey) m.push('Ctrl');
  if (e.altKey) m.push('Alt');
  let key = e.key;
  // Shift with a letter: chord includes Shift + uppercase letter. Shift with symbols: the symbol already encodes it.
  const isLetter = /^[a-z]$/i.test(key);
  if (e.shiftKey && (isLetter || key.length > 1)) m.push('Shift');
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toUpperCase();
  // with Alt on macOS e.key may be a special glyph; fall back to code
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  if (/^Digit\d$/.test(e.code) && (e.ctrlKey || e.metaKey || e.altKey)) key = e.code.slice(5);
  return [...m, key].join('+');
}

/** Find the command bound to this key event (or undefined). */
export function commandForEvent(e: KeyboardEvent): Command | undefined {
  const chord = chordFromEvent(e);
  for (const c of allCommands()) {
    const hk = effectiveHotkey(c.id);
    if (!hk) continue;
    for (const one of hk.split(',')) if (normalizeChord(one) === chord) return c;
  }
  return undefined;
}

/** The full current hotkey map (id → chord) for the JSON editor. */
export function hotkeyMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of allCommands()) out[c.id] = effectiveHotkey(c.id);
  return out;
}
