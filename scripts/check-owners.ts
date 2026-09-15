import fs from "fs";
import path from "path";

import hre from "hardhat";
import { Contract } from "ethers";

const PROXY_ABI = [
    "function getOwner() view returns (address)",
    "function getImplementation() view returns (address)",
];
const OWNABLE_ABI = ["function owner() view returns (address)"];

type Row = {
    name: string;
    address: string;
    proxyOwner: string;
    implementation: string;
    businessOwner: string;
};

async function safeCall<T>(fn: () => Promise<T>): Promise<T | "-"> {
    try {
        return await fn();
    } catch {
        return "-";
    }
}

async function main() {
    const network = hre.network.name;
    const deploymentsDir = path.join(
        __dirname,
        "..",
        "deployment",
        "deployments",
        network
    );

    if (!fs.existsSync(deploymentsDir)) {
        throw new Error(`Deployments directory not found: ${deploymentsDir}`);
    }

    const files = fs.readdirSync(deploymentsDir);
    const proxyNames = files
        .filter((f) => f.endsWith("_Proxy.json"))
        .map((f) => f.replace("_Proxy.json", ""))
        .sort();

    const plainNames = files
        .filter(
            (f) =>
                f.endsWith(".json") &&
                !f.endsWith("_Proxy.json") &&
                !f.endsWith("_Implementation.json") &&
                !f.includes("solcInputs") &&
                f !== ".chainId"
        )
        .map((f) => f.replace(".json", ""))
        .filter((n) => !proxyNames.includes(n))
        .sort();

    const provider = hre.ethers.provider;
    const rows: Row[] = [];

    const readAddress = (file: string): string =>
        JSON.parse(fs.readFileSync(path.join(deploymentsDir, file), "utf8")).address;

    for (const name of proxyNames) {
        const proxyAddress = readAddress(`${name}_Proxy.json`);
        const proxy = new Contract(proxyAddress, PROXY_ABI, provider);
        const ownableViaProxy = new Contract(proxyAddress, OWNABLE_ABI, provider);

        const [proxyOwner, implementation, businessOwner] = await Promise.all([
            safeCall(() => proxy.getOwner()),
            safeCall(() => proxy.getImplementation()),
            safeCall(() => ownableViaProxy.owner()),
        ]);

        rows.push({
            name,
            address: proxyAddress,
            proxyOwner: proxyOwner as string,
            implementation: implementation as string,
            businessOwner: businessOwner as string,
        });
    }

    for (const name of plainNames) {
        const address = readAddress(`${name}.json`);
        const ownable = new Contract(address, OWNABLE_ABI, provider);
        const businessOwner = await safeCall(() => ownable.owner());
        rows.push({
            name,
            address,
            proxyOwner: "(not proxied)",
            implementation: "(not proxied)",
            businessOwner: businessOwner as string,
        });
    }

    const uniqueOwners = new Set<string>();
    for (const r of rows) {
        if (r.proxyOwner && r.proxyOwner !== "-" && r.proxyOwner !== "(not proxied)")
            uniqueOwners.add(r.proxyOwner.toLowerCase());
        if (r.businessOwner && r.businessOwner !== "-")
            uniqueOwners.add(r.businessOwner.toLowerCase());
    }

    console.log(`\nNetwork: ${network}`);
    console.log(`Contracts scanned: ${rows.length}\n`);

    console.table(
        rows.map((r) => ({
            contract: r.name,
            address: r.address,
            proxyOwner: r.proxyOwner,
            businessOwner: r.businessOwner,
            implementation: r.implementation,
        }))
    );

    console.log("\nUnique owner addresses found:");
    for (const o of uniqueOwners) {
        console.log(`  ${o}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
