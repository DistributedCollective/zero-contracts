import { HardhatRuntimeEnvironment } from "hardhat/types";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getContractNameFromScriptFileName = (filename) => {
    return filename.substring(filename.lastIndexOf("-") + 1, filename.lastIndexOf("."));
};

const assertPerimeterDeploymentNetwork = (network: HardhatRuntimeEnvironment["network"]) => {
    if (network.tags.testnet && network.tags.mainnet) {
        throw new Error("PerimeterOps: conflicting mainnet/testnet network tags");
    }
    if (!network.tags.testnet && !network.tags.mainnet) {
        const url = "url" in network.config ? network.config.url : undefined;
        const localEndpoint =
            (network.name === "localhost" || network.name === "rskdev") &&
            typeof url === "string" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
        if (network.name !== "hardhat" && !localEndpoint) {
            throw new Error("PerimeterOps: explicit mainnet/testnet network tags are required");
        }
    }
};

const ZERO_DELAY_RELEASE_CANDIDATES = [
    "BorrowerOperations",
    "CollSurplusPool",
    "TroveManager",
    "BorrowerOperationsPerimeterOps",
];

const isZeroDelayReleaseNetwork = (network: HardhatRuntimeEnvironment["network"]) =>
    Boolean(
        network.tags.mainnet ||
            network.tags.testnet ||
            network.tags.forked ||
            ("forking" in network.config &&
                network.config.forking?.url &&
                network.config.forking.enabled !== false)
    );

const resolveZeroDelayDeploymentNetwork = async (hre: HardhatRuntimeEnvironment) => {
    assertPerimeterDeploymentNetwork(hre.network);
    if (!["hardhat", "localhost", "rskdev"].includes(hre.network.name) || !hre.network.provider)
        return hre.network;
    let metadata;
    try {
        metadata = await hre.network.provider.send("hardhat_metadata");
    } catch (error) {
        if (hre.network.name !== "hardhat" && (error as { code?: number }).code === -32601)
            return hre.network;
        throw error;
    }
    return metadata.forkedNetwork
        ? { ...hre.network, tags: { ...hre.network.tags, forked: true } }
        : hre.network;
};

const assertZeroDelayDeploymentEnvironment = (network: HardhatRuntimeEnvironment["network"]) => {
    if (isZeroDelayReleaseNetwork(network) && process.env.HARDHAT_DEPLOY_FIXTURE) {
        throw new Error("Zero delay release: implicit deployment fixtures are not permitted");
    }
};

const assertZeroDelayProxyCandidate = (
    network: HardhatRuntimeEnvironment["network"],
    name: string
) => {
    assertZeroDelayDeploymentCandidate(network, name);
    if (
        isZeroDelayReleaseNetwork(network) &&
        !ZERO_DELAY_RELEASE_CANDIDATES.slice(0, 3).includes(name)
    ) {
        throw new Error(`Zero delay release: ${name} is not an approved proxy candidate`);
    }
};

const assertZeroDelayDeploymentCandidate = (
    network: HardhatRuntimeEnvironment["network"],
    name: string
) => {
    assertPerimeterDeploymentNetwork(network);
    assertZeroDelayDeploymentEnvironment(network);
    if (isZeroDelayReleaseNetwork(network) && !ZERO_DELAY_RELEASE_CANDIDATES.includes(name)) {
        throw new Error(`Zero delay release: ${name} is not an approved candidate`);
    }
};

const assertZeroDelayDeploymentSelection = (
    network: HardhatRuntimeEnvironment["network"],
    options: { tags?: string; reset?: boolean; tagsRequireAll?: boolean }
) => {
    assertPerimeterDeploymentNetwork(network);
    assertZeroDelayDeploymentEnvironment(network);
    if (!isZeroDelayReleaseNetwork(network)) return;
    const selected = options.tags?.split(",").filter(Boolean) || [];
    if (options.reset || options.tagsRequireAll || selected.length === 0) {
        throw new Error(
            "Zero delay release: explicit candidate tags without reset or require-all are required"
        );
    }
    for (const name of selected) assertZeroDelayDeploymentCandidate(network, name);
};

const preflightZeroDelayDeployment = async (hre: HardhatRuntimeEnvironment) => {
    const network = await resolveZeroDelayDeploymentNetwork(hre);
    assertPerimeterDeploymentNetwork(network);
    assertZeroDelayDeploymentEnvironment(network);
    if (!isZeroDelayReleaseNetwork(network)) return;
    for (const name of ZERO_DELAY_RELEASE_CANDIDATES.slice(0, 3)) {
        const proxy = await hre.deployments.getOrNull(`${name}_Proxy`);
        if (!proxy)
            throw new Error(`Zero delay release: existing proxy record required for ${name}`);
        if ((await hre.ethers.provider.getCode(proxy.address)) === "0x") {
            throw new Error(`Zero delay release: existing proxy code missing for ${name}`);
        }
        const contract = await hre.ethers.getContractAt("UpgradableProxy", proxy.address);
        const implementation = await contract.getImplementation();
        if ((await hre.ethers.provider.getCode(implementation)) === "0x") {
            throw new Error(`Zero delay release: implementation code missing for ${name}`);
        }
    }
};

const arrayToUnique = (value, index, self) => {
    return self.indexOf(value) === index;
};

const logTimer = (time, passedTime) => {
    const delaySeconds = time / 1000;
    let timer = delaySeconds - passedTime;

    const hours = Math.round(timer / 3600);
    const minutes = Math.round((timer % 3600) / 60);
    const seconds = Math.round(timer % 60);
    const hoursStr = hours < 10 ? "0" + hours : hours;
    const minutesStr = minutes < 10 ? "0" + minutes : minutes;
    const secondsStr = seconds < 10 ? "0" + seconds : seconds;
    process.stdout.write("");
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);

    process.stdout.write(hoursStr + ":" + minutesStr + ":" + secondsStr);
};

export {
    getContractNameFromScriptFileName,
    assertPerimeterDeploymentNetwork,
    ZERO_DELAY_RELEASE_CANDIDATES,
    isZeroDelayReleaseNetwork,
    resolveZeroDelayDeploymentNetwork,
    assertZeroDelayProxyCandidate,
    assertZeroDelayDeploymentCandidate,
    assertZeroDelayDeploymentSelection,
    preflightZeroDelayDeployment,
    arrayToUnique,
    logTimer,
    delay,
};
