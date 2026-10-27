import test from "node:test";
import assert from "node:assert/strict";
import {
  findLinks,
  linkAt,
  createLinkProvider,
} from "../../src/terminal/links";
import {
  cellAtPoint,
  fromLinear,
  linear,
  orderedRange,
  pointOfCell,
  wordAt,
  type Metrics,
} from "../../src/terminal/selection";
import { Screen } from "./helpers/headless";

async function screenWith(text: string, cols = 20): Promise<Screen> {
  const s = new Screen(cols, 10, true);
  s.write(text);
  await s.settle();
  return s;
}

const TB = '  File "/data/projects/app.py", line 12, in <module>';

test("a traceback location is found, with its path and line number", async () => {
  const s = await screenWith(TB, 80);
  const [link] = findLinks(s.buffer, 0);
  assert.equal(link?.kind, "traceback");
  assert.equal(link?.path, "/data/projects/app.py");
  assert.equal(link?.line, 12);
});

test("the traceback link survives the line wrapping over several rows", async () => {
  const s = await screenWith(TB, 20); // 51 characters -> 3 rows
  assert.equal(s.lines().length, 3);
  for (const row of [0, 1, 2]) {
    const [link] = findLinks(s.buffer, row);
    assert.equal(link?.path, "/data/projects/app.py", `row ${row}`);
    assert.equal(link?.line, 12);
  }
  // A tap on the last row, far from the "File" word, still hits the link.
  assert.equal(linkAt(s.buffer, { col: 3, row: 2 }, 20)?.line, 12);
  // ...and a tap on the blank part of a row doesn't.
  assert.equal(linkAt(s.buffer, { col: 18, row: 2 }, 20), null);
});

test("web URLs are found and exclude trailing punctuation", async () => {
  const s = await screenWith("see https://pypi.org/project/numpy/, ok", 80);
  const [link] = findLinks(s.buffer, 0);
  assert.equal(link?.kind, "url");
  assert.equal(link?.url, "https://pypi.org/project/numpy/");
  assert.deepEqual(link?.start, { col: 4, row: 0 });
});

test("a URL wrapped over two rows is one link", async () => {
  const s = await screenWith("go to https://example.com/a/long/path now", 20);
  const links = findLinks(s.buffer, 1);
  assert.equal(links[0]?.url, "https://example.com/a/long/path");
  assert.equal(links[0]?.start.row, 0);
  assert.equal(links[0]?.end.row, 1);
});

test("plain text has no links", async () => {
  const s = await screenWith("hello world", 40);
  assert.deepEqual(findLinks(s.buffer, 0), []);
  assert.deepEqual(findLinks(s.buffer, 5), []); // a row that does not exist
});

test("the xterm link provider reports 1-based ranges for the row asked about", async () => {
  const s = await screenWith("open https://example.com now", 40);
  const provider = createLinkProvider(
    { cols: 40, buffer: { active: s.buffer } },
    new Set(["url"]),
    () => {},
  );
  let got: any;
  provider.provideLinks(1, (links) => (got = links));
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].range, {
    start: { x: 6, y: 1 },
    end: { x: 24, y: 1 },
  });
  let none: any = "unset";
  provider.provideLinks(2, (links) => (none = links));
  assert.equal(none, undefined);
});

test("link kinds can be switched off", async () => {
  const s = await screenWith(TB, 80);
  const provider = createLinkProvider(
    { cols: 80, buffer: { active: s.buffer } },
    new Set(["url"]),
    () => {},
  );
  let got: any = "unset";
  provider.provideLinks(1, (links) => (got = links));
  assert.equal(got, undefined);
});

// ---------------------------------------------------------------- selection

test("linear <-> point conversion round-trips", () => {
  const p = { col: 7, row: 3 };
  assert.deepEqual(fromLinear(linear(p, 20), 20), p);
});

test("orderedRange puts the points in reading order and counts both ends", () => {
  const r = orderedRange({ col: 5, row: 2 }, { col: 3, row: 1 }, 10);
  assert.deepEqual(r.start, { col: 3, row: 1 });
  assert.deepEqual(r.end, { col: 5, row: 2 });
  assert.equal(r.length, 13); // 7 cells left on row 1 + 6 on row 2
  assert.equal(
    orderedRange({ col: 4, row: 0 }, { col: 4, row: 0 }, 10).length,
    1,
  );
});

const metrics: Metrics = {
  left: 10,
  top: 100,
  cellW: 8,
  cellH: 16,
  cols: 20,
  rows: 5,
  viewportY: 30,
};

test("a screen point maps to a buffer cell (scrolled), clamped to the grid", () => {
  assert.deepEqual(cellAtPoint(10 + 8 * 3 + 2, 100 + 16 * 2 + 5, metrics), {
    col: 3,
    row: 32,
  });
  assert.deepEqual(cellAtPoint(-50, 9999, metrics), { col: 0, row: 34 });
  assert.deepEqual(cellAtPoint(9999, -50, metrics), { col: 19, row: 30 });
});

test("handle positions are the cell corners, or null when scrolled out of view", () => {
  assert.deepEqual(pointOfCell({ col: 2, row: 31 }, "start", metrics), {
    x: 10 + 16,
    y: 100 + 2 * 16,
  });
  assert.deepEqual(pointOfCell({ col: 2, row: 31 }, "end", metrics), {
    x: 10 + 24,
    y: 100 + 2 * 16,
  });
  assert.equal(pointOfCell({ col: 0, row: 29 }, "start", metrics), null);
  assert.equal(pointOfCell({ col: 0, row: 35 }, "start", metrics), null);
});

test("wordAt keeps paths and dotted names together and stops at quotes and spaces", async () => {
  const s = await screenWith('File "/data/app.py", line 3', 40);
  const word = wordAt(s.buffer, { col: 12, row: 0 }, 40)!;
  assert.deepEqual(word.start, { col: 6, row: 0 });
  assert.deepEqual(word.end, { col: 17, row: 0 }); // "/data/app.py"
  assert.equal(wordAt(s.buffer, { col: 2, row: 0 }, 40)?.end.col, 3); // "File"
  assert.equal(wordAt(s.buffer, { col: 2, row: 0 }, 40)?.start.col, 0);
  assert.equal(wordAt(s.buffer, { col: 4, row: 0 }, 40), null); // a space
  assert.equal(wordAt(s.buffer, { col: 5, row: 0 }, 40), null); // a quote
  assert.equal(wordAt(s.buffer, { col: 30, row: 0 }, 40), null); // blank area
});

test("wordAt treats a wide character as one unit", async () => {
  const s = await screenWith("a 日本語 b", 20);
  const w = wordAt(s.buffer, { col: 5, row: 0 }, 20)!;
  assert.deepEqual([w.start.col, w.end.col], [2, 7]);
});
