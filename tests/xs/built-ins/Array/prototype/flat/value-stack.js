/*---
description: flat pops every visited item, so its value stack use is O(depth)
---*/

// flat builds its result on the heap, so it must not leave the items it visits
// on the value stack. When it does, its value stack use is O(source length)
// instead of O(depth) and it overflows on a long source. The count below
// exceeds the 256K slot value stack of xst; a machine created with a smaller
// stackCount overflows at a proportionally smaller count.
const count = 300000;

// nested items: each one is flattened by a recursive call
const empty = [];
const nested = [];
for (let i = 0; i < count; i++)
	nested.push(empty);
assert.sameValue(nested.flat().length, 0, "nested items");

// leaf items: each one is defined into the result
const leaves = [];
for (let i = 0; i < count; i++)
	leaves.push(0);
assert.sameValue([leaves].flat().length, count, "leaf items");

// flattening is unaffected
const deep = [1, [2, [3, [4]]]];
assert.sameValue(deep.flat(3).length, 4, "depth 3 length");
assert.sameValue(deep.flat(3)[3], 4, "depth 3 last item");
assert.sameValue(deep.flat().length, 3, "default depth length");
assert.sameValue(deep.flat()[2].length, 2, "default depth last item");
