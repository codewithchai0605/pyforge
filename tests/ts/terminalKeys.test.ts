import test from "node:test";
import assert from "node:assert/strict";
import { applyModifiers, encodeKey, NO_MODS } from "../../src/terminal/keys";

const m = (ctrl = false, alt = false, shift = false) => ({ ctrl, alt, shift });

test("plain keys", () => {
    assert.equal(encodeKey("Escape"), "\x1b");
    assert.equal(encodeKey("Tab"), "\t");
    assert.equal(encodeKey("Enter"), "\r");
    assert.equal(encodeKey("Backspace"), "\x7f");
    assert.equal(encodeKey("ArrowUp"), "\x1b[A");
    assert.equal(encodeKey("ArrowLeft"), "\x1b[D");
    assert.equal(encodeKey("Home"), "\x1b[H");
    assert.equal(encodeKey("End"), "\x1b[F");
    assert.equal(encodeKey("PageUp"), "\x1b[5~");
    assert.equal(encodeKey("Delete"), "\x1b[3~");
});

test("application cursor mode switches arrows and Home/End to SS3", () => {
    assert.equal(encodeKey("ArrowUp", NO_MODS, true), "\x1bOA");
    assert.equal(encodeKey("Home", NO_MODS, true), "\x1bOH");
    // PageUp is not a cursor key and does not change.
    assert.equal(encodeKey("PageUp", NO_MODS, true), "\x1b[5~");
});

test("modifiers use xterm's 1 + shift + 2*alt + 4*ctrl parameter", () => {
    assert.equal(encodeKey("ArrowRight", m(true)), "\x1b[1;5C");
    assert.equal(encodeKey("ArrowLeft", m(false, true)), "\x1b[1;3D");
    assert.equal(encodeKey("ArrowUp", m(true, false, true)), "\x1b[1;6A");
    assert.equal(encodeKey("Delete", m(true)), "\x1b[3;5~");
    // Modifiers win over application mode, as xterm does.
    assert.equal(encodeKey("ArrowUp", m(true), true), "\x1b[1;5A");
});

test("Shift+Tab, Alt+Enter, Ctrl+Backspace", () => {
    assert.equal(encodeKey("Tab", m(false, false, true)), "\x1b[Z");
    assert.equal(encodeKey("Enter", m(false, true)), "\x1b\r");
    assert.equal(encodeKey("Backspace", m(true)), "\x08");
});

test("Ctrl turns a typed letter into its control code", () => {
    assert.equal(applyModifiers("c", m(true)), "\x03");
    assert.equal(applyModifiers("C", m(true)), "\x03");
    assert.equal(applyModifiers("d", m(true)), "\x04");
    assert.equal(applyModifiers("z", m(true)), "\x1a");
    assert.equal(applyModifiers("[", m(true)), "\x1b");
    assert.equal(applyModifiers(" ", m(true)), "\x00");
});

test("Alt prefixes ESC; Ctrl+Alt does both", () => {
    assert.equal(applyModifiers("b", m(false, true)), "\x1bb");
    assert.equal(applyModifiers("b", m(true, true)), "\x1b\x02");
});

test("anything that is not one printable character passes through", () => {
    assert.equal(applyModifiers("hello", m(true)), "hello");
    assert.equal(applyModifiers("\x1b[A", m(true)), "\x1b[A");
    assert.equal(applyModifiers("\r", m(true)), "\r");
    assert.equal(applyModifiers("1", m(true)), "1"); // no control code for it
    assert.equal(applyModifiers("a", NO_MODS), "a");
});