/*---
description: flatMap pops every mapped item, so its value stack use is O(1)
---*/

// See tests/xs/built-ins/Array/prototype/flat/value-stack.js: flatMap shares
// the loop that flat uses, so a mapper returning arrays must not accumulate
// them on the value stack.
const count = 300000;

const source = [];
for (let i = 0; i < count; i++)
	source.push(i);

// mapped arrays: each one is flattened by a recursive call
const empty = [];
assert.sameValue(source.flatMap(() => empty).length, 0, "mapped arrays");

// mapped items: each one is defined into the result
assert.sameValue(source.flatMap(item => item).length, count, "mapped items");

// mapping is unaffected: one level only
const mapped = [1, 2].flatMap(item => [item, [item]]);
assert.sameValue(mapped.length, 4, "mapped length");
assert.sameValue(mapped[0], 1, "mapped item");
assert.sameValue(mapped[1].length, 1, "mapped nested item");
