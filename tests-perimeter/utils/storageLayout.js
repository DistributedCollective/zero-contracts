// Shared helper for the storage-layout zero-diff regression guard.
//
// Extracts a NORMALIZED storage layout for a fully-qualified contract from the
// hardhat build-info (solc `storageLayout` output, enabled in hardhat.config.ts
// for 0.6.11). Normalization strips the solc AST node-id suffixes that follow a
// `)` in type strings (e.g. `t_struct(Foo)1234_storage` →
// `t_struct(Foo)_storage`) — those numeric ids shift with the compilation set
// and are NOT a storage-layout change.

const hre = require("hardhat");

// Strip `)<digits>` id suffixes wherever they appear in a solc type string.
const normType = (t) => (typeof t === "string" ? t.replace(/\)[0-9]+/g, ")") : t);

// Return a stable, comparable array of {label, slot, offset, type} for the
// contract's declared state variables. Throws (never silently empties) if the
// layout is missing/empty — an empty layout compared to an empty layout is a
// silent false PASS, which would make this guard useless.
async function normalizedLayout(fqName) {
    const bi = await hre.artifacts.getBuildInfo(fqName);
    if (!bi) throw new Error(`no build-info for ${fqName} (compile with storageLayout enabled)`);
    const [source, name] = fqName.split(":");
    const artifact = bi.output.contracts[source] && bi.output.contracts[source][name];
    if (!artifact) throw new Error(`contract ${fqName} not found in its build-info output`);
    const layout = artifact.storageLayout;
    if (!layout || !Array.isArray(layout.storage)) {
        throw new Error(`no storageLayout for ${fqName} — is "storageLayout" in outputSelection?`);
    }
    if (layout.storage.length === 0) {
        throw new Error(
            `${fqName} storageLayout has ZERO entries — refusing to treat as zero-diff (silent false pass)`
        );
    }
    return layout.storage
        .map((s) => ({
            label: s.label,
            slot: String(s.slot),
            offset: s.offset,
            type: normType(s.type),
        }))
        .sort(
            (a, b) =>
                Number(a.slot) - Number(b.slot) ||
                a.offset - b.offset ||
                a.label.localeCompare(b.label)
        );
}

module.exports = { normalizedLayout, normType };
