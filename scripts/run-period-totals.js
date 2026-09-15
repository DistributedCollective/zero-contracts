const { spawnSync } = require("child_process");

const argv = process.argv.slice(2);
let network = null;
const scriptArgs = [];

for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--network") {
        network = argv[i + 1];
        if (!network) {
            console.error("Missing value for --network");
            process.exit(1);
        }
        i += 1;
        continue;
    }

    scriptArgs.push(arg);
}

if (!network) {
    console.error("Missing required --network <name> argument");
    process.exit(1);
}

const nodeArgs = [
    "-r",
    "ts-node/register/transpile-only",
    "scripts/report-period-totals.ts",
    ...scriptArgs,
];

const result = spawnSync(process.execPath, nodeArgs, {
    stdio: "inherit",
    env: {
        ...process.env,
        HARDHAT_NETWORK: network,
    },
});

if (result.error) {
    console.error(result.error);
    process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
