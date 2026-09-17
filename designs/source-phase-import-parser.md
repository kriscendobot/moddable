# XS module import phases

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-09-17 |
| Engine baseline | Moddable XS at `5516726818906190d3a042d8be90219ce9d51b45` (XS 17.9.1) |
| Scope | `import source`, `import.source()`, and `import defer` from parser through module loading |
| First staging milestone | `source-key/brand-and-identity.js` reaches its assertions after the static-source vertical slice, then becomes the first green Compartments test after the proposal Compartment gains source-keyed `exports()` |

## Problem

XS 17.9.1 rejects all three module-phase forms before module semantics run:

```text
import source s from "./dep.mjs"       SyntaxError: missing from
await import.source("./dep.mjs")       SyntaxError: invalid import.
import defer * as ns from "./dep.mjs"  SyntaxError: missing from
```

The parser currently lowers every static dependency to a transfer containing a
local name, specifier, imported name, aliases, and an import-attributes flag.
[`fxScopeCodeSpecifierNodes`](../xs/sources/xsCode.c) emits that transfer as
`XS_CODE_TRANSFER`, and [`fxPrepareTransfer`](../xs/sources/xsModule.c) builds
the runtime object. No layer records which module phase the source requested.
Dynamic import has the same loss: [`fxImportCallNodeCode`](../xs/sources/xsCode.c)
always emits `XS_CODE_IMPORT` and [`fxRunImport`](../xs/sources/xsModule.c)
always loads through evaluation.

The source-phase proposal, ECMA-262 draft clause 16.1.1.1
[ModuleRequest Records](https://tc39.es/proposal-source-phase-imports/#sec-modulerequest-records),
defines `[[Phase]]` as part of the request. The import-defer proposal uses the
same field in clause 16.2.1.1
[ModuleRequest Records](https://tc39.es/proposal-defer-import-eval/#sec-modulerequest-records)
and changes evaluation in clause 16.2.1.5.3
[Evaluate](https://tc39.es/proposal-defer-import-eval/#sec-moduleevaluation).
XS must preserve that one phase field. Encoding a new Compartment-only phase
would break the proposals' guarantee that source, defer, and evaluation requests
address the same module-map entry.

XS already has a `ModuleSource` object and compiled module representation. That
is useful implementation material, but the `ModuleSource(sourceText)` constructor
does not provide the cached source object belonging to a host-loaded module.
The source phase must expose that cached object. The existing `Compartment`
constructor is the retired, fresh-global, hook-based SES surface. This design
does not treat it as the Compartments proposal object or extend it to make a
staging test appear green.

## Goals and non-goals

This design:

- parses the three required forms with their specified grammar and early errors;
- carries one `txModulePhase` value through AST nodes, bytecode, transfers,
  request queues, dynamic-import waiters, and host loading;
- reuses XS `ModuleSource` instances as the source-phase result and caches one
  result per loaded module record;
- leaves phase out of the module cache key, while keeping import attributes in
  that key;
- gives `import defer` a distinct namespace and evaluation path; and
- identifies the fork and submodule work required for xsnap and endor.

This design does not define the new Compartments proposal constructor, its
cross-Compartment routing policy, or its source-keyed instance maps. It also does
not add dynamic `import.defer()`, deferred re-exports, or a JavaScript loader API.
Those surfaces can consume the same phase representation later.

## Design

### One phase type

Add a compact enum shared by the parser and runtime:

```c
typedef enum {
	XS_MODULE_PHASE_SOURCE,
	XS_MODULE_PHASE_DEFER,
	XS_MODULE_PHASE_EVALUATION,
} txModulePhase;
```

The ordering is intentional: source loads only the requested module record,
defer loads and links the graph, and evaluation also executes the ordinary
synchronous graph. Phase is not an import attribute and is not folded into
`XS_JSON_MODULE_FLAG`. Cache lookup continues to use realm, resolved specifier,
and attributes. If the same key is requested at more than one phase, the loader
upgrades work on the same module record rather than creating another record.

### Parser and AST

Keep `source` and `defer` contextual. Add `sourceSymbol` and `deferSymbol` to
`txParser`, initialized beside `fromSymbol` and `metaSymbol` by
[`fxInitializeParser`](../xs/sources/xsScript.c). Do not add reserved-word tokens.

[`fxImportDeclaration`](../xs/sources/xsSyntaxical.c) applies these productions:

- `import source ImportedBinding from ModuleSpecifier [with ...];` accepts one
  binding only and sets phase to source.
- `import defer * as ImportedBinding from ModuleSpecifier [with ...];` accepts
  only a namespace binding and sets phase to defer.
- Existing import declarations set phase to evaluation.
- Escaped spellings of the contextual modifier are rejected as modifiers.
  Existing identifier uses of `source` and `defer` remain valid.

Add `phase` to `txImportNode` and copy it to every `txSpecifierNode` created by
[`fxImportNodeHoist`](../xs/sources/xsScope.c). This puts the phase on each
compiled request, including a side-effect-only request. A source import uses the
existing transfer shape with a local name and no imported export name; its phase
distinguishes it from an evaluation-phase namespace import.

[`fxLiteralExpression`](../xs/sources/xsSyntaxical.c) recognizes
`import.source(...)` next to `import.meta`. It parses the same argument and
options shape as `import(...)`, creates a `txImportCallNode` with source phase,
and retains the existing module-only restrictions. Plain `import(...)` records
evaluation phase.

### Bytecode

Append, rather than insert, phase-specific opcodes so existing opcode numbers do
not move:

- `XS_CODE_TRANSFER_SOURCE` and `XS_CODE_TRANSFER_DEFER` construct static
  transfers with the corresponding phase. Existing `XS_CODE_TRANSFER` means
  evaluation.
- `XS_CODE_IMPORT_SOURCE` performs a dynamic source request. Existing
  `XS_CODE_IMPORT` means evaluation.

Update `gxCodeNames`, `gxCodeSizes`, the computed-goto table in
[`fxRun`](../xs/sources/xsRun.c), the linker and strip tables under
[`xs/tools`](../xs/tools), and snapshot callback tables as required. The new
opcodes must be included in the bytecode version check. An `.xsb` or snapshot
compiled by a phase-aware compiler is not silently accepted by an older VM.

The VM opcodes call one helper with an explicit `txModulePhase`; separate opcodes
are serialization details, not separate semantic mechanisms.

### Runtime ModuleRequest representation

The XS transfer is the compiled static ModuleRequest. Extend it with an internal
phase slot and a `mxTransferPhase` accessor. `fxPrepareTransfer` initializes that
slot from the opcode. Update transfer duplication and `ModuleSource.prototype.bindings`
reflection so cloning or inspecting a compiled source does not discard phase.

The load queue currently stores only a module reference. Give each queue entry a
requested phase. `fxQueueModule` coalesces entries by module identity and raises
the recorded phase when a stronger request arrives. Dynamic-import waiters also
record their phase because their fulfillment value differs: a source request
receives a source object, a defer request receives a deferred namespace, and an
evaluation request receives the ordinary namespace.

Thread the phase through `fxRunImport`, `fxLoadModules`, `fxLoadModulesFrom`, and
the platform load call. The phase is available to a host loader as request data,
not encoded in the specifier or options attributes. Existing XS hook adapters may
expose it as a read-only `phase` option, but must pass the same enum internally.

### Source phase

Add an explicit cached source-object slot to the module-instance layout. When a
module has been parsed or its archive bytecode loaded, create its `ModuleSource`
with `fxNewModuleSourceInstance`, populate it from the compiled module using the
existing `fxDuplicateModuleTransfers` path, and cache it. Static and dynamic
source imports return that exact object.

A source-phase queue entry stops after the requested module is resolved, loaded,
and compiled. It does not call `fxLoadModulesFrom` for that module, link it, or
execute it. A later defer or evaluation request upgrades the same module record
and continues from its loaded state. A source-phase transfer initializes its
local binding from the cached source object instead of calling
`fxLinkNamespace`.

The cached object carries the existing `XS_MODULE_SOURCE_KIND` internal brand.
Completing the source-phase proposal also requires placing `ModuleSource.prototype`
under `%AbstractModuleSource%.prototype` and treating that internal record as
`[[ModuleSourceRecord]]`; it must not introduce a second source-key class for
Compartments.

### Defer phase

A defer request loads and links the ordinary module graph, but its transfer binds
a cached deferred namespace distinct from the ordinary namespace. Add a deferred
namespace exotic wrapper that points to the module record and records deferred
state. Its property read path synchronously evaluates the target when needed,
then delegates to the ordinary namespace. It omits the special `then` export and
rethrows a stored evaluation error on every access, as required by clause 10.4.6
[Module Namespace Exotic Objects](https://tc39.es/proposal-defer-import-eval/#sec-module-namespace-exotic-objects).

During evaluation, an evaluation-phase edge is traversed normally. A defer edge
is skipped for synchronous execution, but its asynchronous transitive
dependencies are gathered and evaluated before the importing module completes.
This is the behavior in clause 16.2.1.5.3.2
[GatherAsynchronousTransitiveDependencies](https://tc39.es/proposal-defer-import-eval/#sec-gather-asynchronous-transitive-dependencies).
Source edges never participate in linking or evaluation.

### Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
| --- | --- | --- | --- | --- | --- |
| Parser -> bytecode VM | Parser recognizes contextual syntax; compiler emits phase opcodes | TC39 grammar selects phase | `.xsb` and snapshot bytecode are owned by XS tooling | XS bytecode versioning accepts or rejects an archive | `txModulePhase` encoded by an XS opcode |
| VM -> module loader | Runtime transfer and queue carry the phase | XS module algorithms decide load, link, and evaluation work | Module/source/namespace caches live only in the XS heap | XS owns link, evaluation, error, and cache state | One ModuleRequest: specifier, attributes, phase |
| XS fork -> xsnap/endor | xsnap compiles the pinned C engine; endor supplies host module bytes and resolution | Endor chooses locations and target Compartments, not phase semantics | Endo owns the gitlink, generated bundles, and any checked-in `libxs.a` | Endo chooses the fork pin; XS classifies execution and module status | The same phase-aware XS ABI and bytecode archive |

XS owns in-memory module and source identity. Endo owns persistent pins and
generated artifacts. XS decides whether execution linked, evaluated, or threw;
Endo decides which module bytes a resolved request names. XS owns retry and
evaluation continuation inside one machine, while endor owns worker restart and
archive regeneration. The names follow their layer: `txModulePhase` and a module
request are engine concepts; no XS type is named for an endor worker lifecycle.

## Pinned submodule and fork cost

The validation used `c/moddable` at `5516726`. As of 2026-09-17, the
`endojs/endo-but-for-bots` roadmap branch pins `23b4d6b0`, but both pins lack the
three forms. Implementation should first rebase this design onto the pin endor
actually carries, then place the phase commits on `kriscendobot/moddable`.

A fork-only commit is not fetchable from the current submodule URL
`https://github.com/Moddable-OpenSource/moddable.git`. Adopting it therefore costs
all of the following in endor:

1. update `.gitmodules` to the fork, or arrange an upstream-equivalent commit,
   and move the `c/moddable` gitlink to the implementation SHA;
2. rebuild XS through `rust/endo/xsnap/build.rs`, with `mxModulePhases` enabled;
3. rebuild every `.xsb`, snapshot, and boot bundle with the matching compiler
   because the bytecode set and version changed;
4. refresh any checked-in `rust/endo/xsnap/prebuilt/libxs.a`; and
5. run xsnap archive, module-loader, snapshot, metering, and determinism tests
   before the Compartments suite.

The design keeps `txModulePhase` inside XS and preserves the existing public C
entry points where possible, so Rust `ffi.rs` should not need a new function.
If a platform overrides `fxLoadModule`, its callback signature must accept the
request phase; xsnap currently selects the default loader and avoids that ABI
change. Endor's Rust host registry still needs tests showing that source requests
return compiled source identity without recursively loading dependencies.

## Staged implementation

1. **Smallest running slice: static source import.** Add the enum, the
   `import source` contextual grammar, AST field, source-transfer opcode,
   transfer phase slot, and bytecode-version change. Cache one `ModuleSource`
   per loaded module and stop its source-phase load before dependency traversal.
   With only this vertical slice, `source-key/brand-and-identity.js` parses,
   loads both fixtures as source objects, and reaches the first proposal
   Compartment assertion instead of failing in the parser. This is the first
   ratchet, but it is deliberately not reported as a green test.
2. **Complete parser and phase transport.** Add `import.source()`, `import defer`,
   the dynamic-source and defer opcodes, phase-aware queues and waiters, and all
   parser positives and negatives. Enable the compile-time feature in `xst`.
   All 10 Compartments files then cross the syntax barrier and fail only at
   missing proposal semantics.
3. **Complete source semantics.** Fulfill `import.source()` with the same cached
   object as static `import source`. Add direct XS tests for identity,
   attributes, missing source representations, and a source whose dependency
   cannot be resolved.
4. **First green Compartments test.** Implement the proposal Compartment as a
   separate replacement surface and give it only source-key branding plus a
   source-keyed deferred-exports identity map. Do not graft these methods onto
   the retired Compartment. This is the smallest semantic increment that makes
   `source-key/brand-and-identity.js` green. Then add shared-global instantiation
   and import evaluation for the remaining non-defer tests.
5. **Deferred namespace and evaluation.** Add the deferred namespace exotic,
   phase-aware evaluation traversal, TLA gathering, and persistent error behavior.
   Gate this stage on XS's import-defer tests before running
   `intersection/import-defer-and-tla.js`.
6. **xsnap and endor adoption.** Move the submodule pin and URL, rebuild all
   generated artifacts, run the XS suite through xsnap, then run the 10 staged
   Compartments tests through endor. A parser-only pin is not an endor milestone.

## Test plan

- Parser positives cover all three forms with and without attributes. Parser
  negatives cover named source imports, non-namespace defer imports, escaped
  modifiers, and phase syntax in scripts.
- Bytecode tests disassemble static and dynamic forms and assert the encoded
  phase. Archive tests reject a phase-aware archive on an older VM.
- Source tests assert static/dynamic identity, ordinary/source cache coalescing,
  no transitive source load, and `ReferenceError` for a module kind without a
  source representation.
- Defer tests cover access-triggered execution, repeated access, stored errors,
  cycles, the excluded `then` export, and eager asynchronous dependencies.
- Regression runs cover ordinary imports, import attributes, JSON modules,
  existing `ModuleSource(sourceText)`, legacy Compartment fixtures, xsl stripping,
  snapshots, and module archives.
- The staging ratchet records `0/10` at the parser baseline, then requires
  `source-key/brand-and-identity.js` as the first green test. Every later stage
  adds named tests to the ratchet; it never reports parser acceptance as semantic
  success.

## Alternatives considered

- **Put phase in the JSON/import-attributes flag.** Rejected. Attributes affect
  module identity; phase controls how far one request proceeds and has three
  values.
- **Use a separate module cache per phase.** Rejected. It would permit duplicate
  records and evaluation, contrary to the shared ModuleRequest key.
- **Desugar source imports to `new ModuleSource(sourceText)`.** Rejected. The
  parser does not own host source bytes, and a new compilation loses host cache
  identity.
- **Implement defer with a JavaScript proxy.** Rejected. Namespace exotic reads,
  synchronous evaluation, TLA graph handling, and repeated error throws belong
  to the module runtime.
- **Extend the current Compartment global.** Rejected. Its fresh global and
  specifier/hook protocol are the retired SES design, not the proposal surface.

## Open questions

None for the parser and phase transport. Whether the fork is later carried
upstream determines if endor can restore the upstream submodule URL, but does not
change the implementation shape.
