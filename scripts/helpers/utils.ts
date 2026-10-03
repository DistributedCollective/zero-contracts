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
    arrayToUnique,
    logTimer,
    delay,
};
