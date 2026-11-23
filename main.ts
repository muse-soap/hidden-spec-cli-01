// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output
// and exit codes, safe paths, format detection, the three matching tiers, unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines, its own line break, and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** Matching lines (SPEC.md section 5): the three tiers and the writing of the new lines. */
const NORMS: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

/** A line of N: its text, and the index into O when it is a context line (-1 when it is not). */
interface NLine {
  t: string;
  ctx: number;
}

function occurrences(lines: string[], O: string[], tier: number): number[] {
  const norm = NORMS[tier]!;
  const no = O.map(norm);
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (norm(lines[i + j]!) !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const occ = occurrences(lines, O, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** Replace the oLen lines at `at` by N: context lines come from the file, tier 2 re-indents the rest. */
function applyN(lines: string[], at: number, oLen: number, N: NLine[], tier: number, O: string[]): string[] {
  const out = lines.slice(0, at);
  const F = oLen > 0 ? leadWs(lines[at]!) : '';
  const P = oLen > 0 ? leadWs(O[0]!) : '';
  for (const n of N) {
    if (n.ctx >= 0) out.push(lines[at + n.ctx]!);
    else if (tier === 2 && oLen > 0 && n.t.trim() !== '' && n.t.startsWith(P)) out.push(F + n.t.slice(P.length));
    else out.push(n.t);
  }
  out.push(...lines.slice(at + oLen));
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Unified diffs (SPEC.md section 6). */
interface Hunk {
  a: number;
  O: string[];
  N: NLine[];
  bsN: boolean;
  bsPlus: boolean;
  hasPlus: boolean;
}

function buildHunk(a: number, body: string[]): Hunk {
  const O: string[] = [];
  const N: NLine[] = [];
  let lastN = -1;
  let lastPlus = -1;
  body.forEach((bl, idx) => {
    const c = bl[0];
    if (bl === '' || c === ' ') {
      const t = bl === '' ? '' : bl.slice(1);
      O.push(t);
      N.push({ t, ctx: O.length - 1 });
      lastN = idx;
    } else if (c === '-') O.push(bl.slice(1));
    else if (c === '+') {
      N.push({ t: bl.slice(1), ctx: -1 });
      lastN = idx;
      lastPlus = idx;
    }
  });
  const after = (k: number): boolean => k >= 0 && (body[k + 1] ?? '').startsWith('\\');
  return { a, O, N, bsN: after(lastN), bsPlus: after(lastPlus), hasPlus: lastPlus >= 0 };
}

interface USec {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
  header: boolean;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const pathOf = (line: string): string => {
    let raw = line.slice(4);
    const tab = raw.indexOf('\t');
    if (tab >= 0) raw = raw.slice(0, tab);
    raw = raw.trim();
    if (raw !== '/dev/null' && (raw.startsWith('a/') || raw.startsWith('b/'))) raw = raw.slice(2);
    return raw;
  };
  const newSec = (): USec => ({ gitOld: null, gitNew: null, pairOld: null, pairNew: null, renFrom: null, renTo: null, newFile: false, delFile: false, hunks: [], header: true });
  const secs: USec[] = [];
  let cur: USec | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.+?) b\/(.+)$/.exec(line.slice(11));
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSec();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      secs.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        const c = bl[0];
        if (bl === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push(bl);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(parseInt(hm[1]!, 10), body));
      cur.header = false;
      i = j;
      continue;
    }
    const pairStart = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (pairStart && !(cur !== null && cur.header && cur.pairOld === null)) {
      cur = newSec();
      cur.pairOld = pathOf(line);
      cur.pairNew = pathOf(lines[i + 1]!);
      secs.push(cur);
      i += 2;
      continue;
    }
    if (cur !== null && cur.header) {
      if (pairStart) {
        cur.pairOld = pathOf(line);
        cur.pairNew = pathOf(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i++;
      continue;
    }
    i++;
  }
  return secs.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: USec, strict: boolean): Edit {
  const oldP = sec.pairOld ?? sec.renFrom ?? sec.gitOld;
  const newP = sec.pairNew ?? sec.renTo ?? sec.gitNew;
  const isCreate = sec.newFile || sec.pairOld === '/dev/null';
  const isDelete = sec.delFile || sec.pairNew === '/dev/null';
  return (tree) => {
    if (isCreate) {
      const np = newP!;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const content: string[] = [];
      let final = true;
      for (const h of sec.hunks) {
        for (const n of h.N) if (n.ctx < 0) content.push(n.t);
        if (h.hasPlus) final = !h.bsPlus;
      }
      tree.now.set(np, content.length === 0 ? '' : content.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    const isMove = op !== np;
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const model = splitFile(before);
    let lines = model.lines;
    let final = model.final;
    let d = 0;
    for (const h of sec.hunks) {
      if (h.O.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, lines.length));
        const atEnd = at >= lines.length;
        lines = applyN(lines, at, 0, h.N, 0, h.O);
        if (atEnd) final = !h.bsN;
        d += h.N.length;
      } else {
        const found = findTier(lines, h.O, strict);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.occ[0]!;
        for (const p of found.occ) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        const runsToEnd = best + h.O.length === lines.length;
        lines = applyN(lines, best, h.O.length, h.N, found.tier, h.O);
        if (runsToEnd) final = !h.bsN;
        d += h.N.length - h.O.length;
      }
    }
    tree.now.set(np, joinFile({ lines, br: model.br, final }));
    if (isMove) {
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    }
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    O: string[];
    N: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${i + 1}`);
    }
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, O: lines.slice(i + 1, j), N: lines.slice(j + 1, k) });
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.O.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.N.length === 0 ? '' : b.N.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = splitFile(before);
    const found = findTier(model.lines, b.O, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const lines = applyN(model.lines, found.occ[0]!, b.O.length, b.N.map((t) => ({ t, ctx: -1 })), found.tier, b.O);
    tree.now.set(b.path, joinFile({ lines, br: model.br, final: model.final }));
  });
}

/** V4A patches (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      lastNB = k;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const startOf = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  const edits: Edit[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind = startOf(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(kind === 'add' ? 14 : 17).trim();
    const secLine = i + 1;
    const raw: { l: string; no: number }[] = [];
    let j = i + 1;
    while (j < lastNB && startOf(lines[j]!) === null) {
      raw.push({ l: lines[j]!, no: j + 1 });
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.l)) raw.pop();
    if (kind === 'add') edits.push(v4aAdd(path, raw));
    else if (kind === 'del') edits.push(v4aDelete(path, raw));
    else edits.push(v4aUpdate(path, raw, secLine, strict));
    i = j;
  }
  return edits;
}

function v4aAdd(path: string, raw: { l: string; no: number }[]): Edit {
  const content: string[] = [];
  for (const r of raw) {
    if (r.l.startsWith('+')) content.push(r.l.slice(1));
    else if (r.l === '') content.push('');
    else throw new Exit2(`error: parse ${r.no}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function v4aDelete(path: string, raw: { l: string; no: number }[]): Edit {
  for (const r of raw) if (!blank(r.l)) throw new Exit2(`error: parse ${r.no}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, raw: { l: string; no: number }[], secLine: number, strict: boolean): Edit {
  interface Chunk {
    anchor: string | null;
    O: string[];
    N: NLine[];
    eof: boolean;
  }
  let moveTo: string | null = null;
  let start = 0;
  if (raw.length > 0 && raw[0]!.l.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.l.slice(13).trim();
    start = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (let k = start; k < raw.length; k++) {
    const { l, no } = raw[k]!;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, O: [], N: [], eof: false };
      chunks.push(cur);
    } else if (l.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      cur = null;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, O: [], N: [], eof: false };
        chunks.push(cur);
      }
      if (l === '' || l[0] === ' ') {
        const t = l === '' ? '' : l.slice(1);
        cur.O.push(t);
        cur.N.push({ t, ctx: cur.O.length - 1 });
      } else if (l[0] === '-') cur.O.push(l.slice(1));
      else cur.N.push({ t: l.slice(1), ctx: -1 });
    } else throw new Exit2(`error: parse ${no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(before);
    let lines = model.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines = applyN(lines, at, 0, ch.N, 0, ch.O);
        cursor = at + ch.N.length;
      } else {
        let placed: { tier: number; at: number } | null = null;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          const occ = occurrences(lines, ch.O, tier).filter((p) => p >= cursor && (!ch.eof || p + ch.O.length === lines.length));
          if (occ.length > 0) {
            placed = { tier, at: occ[0]! };
            break;
          }
        }
        if (placed === null) throw new Fail('no-match', path);
        lines = applyN(lines, placed.at, ch.O.length, ch.N, placed.tier, ch.O);
        cursor = placed.at + ch.N.length;
      }
    }
    const dest = moveTo ?? path;
    tree.now.set(dest, joinFile({ lines, br: model.br, final: model.final }));
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    }
  };
}

function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const norm = NORMS[tier]!;
    const na = norm(anchor);
    for (let i = cursor; i < lines.length; i++) if (norm(lines[i]!) === na) return i;
  }
  return -1;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rPairs = tree.moves.filter(([o, n]) => {
    const po = changed.get(o);
    const pn = changed.get(n);
    return po !== undefined && pn !== undefined && po.was !== null && po.now === null && pn.was === null && pn.now !== null;
  });
  const rOld = new Set(rPairs.map(([o]) => o));
  const rNew = new Set(rPairs.map(([, n]) => n));
  const rows: { key: string; text: string }[] = [];
  for (const [p, { was, now }] of changed) {
    if (rOld.has(p) || rNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of rPairs) rows.push({ key: n, text: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, { now }] of changed) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
