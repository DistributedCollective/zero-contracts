import { extendEnvironment, subtask, task } from "hardhat/config";
import {
    assertZeroDelayDeploymentSelection,
    preflightZeroDelayDeployment,
    ZERO_DELAY_RELEASE_CANDIDATES,
    resolveZeroDelayDeploymentNetwork,
    isZeroDelayReleaseNetwork,
} from "../scripts/helpers/utils";

const guardedDeploy = async (args, hre, runSuper) => {
    assertZeroDelayDeploymentSelection(await resolveZeroDelayDeploymentNetwork(hre), args);
    await preflightZeroDelayDeployment(hre);
    return runSuper(args);
};

task("deploy").setAction(guardedDeploy);
subtask("deploy:main").setAction(guardedDeploy);
subtask("deploy:runDeploy").setAction(guardedDeploy);

task("node").setAction(async (args, hre, runSuper) => {
    const network = await resolveZeroDelayDeploymentNetwork(hre);
    const forkNetwork = args.fork
        ? { ...network, tags: { ...network.tags, forked: true } }
        : network;
    if (isZeroDelayReleaseNetwork(forkNetwork)) {
        if (!args.noReset) throw new Error("Zero delay release: fork node requires no-reset");
        if (!args.noDeploy) assertZeroDelayDeploymentSelection(forkNetwork, args);
    }
    return runSuper(args);
});

extendEnvironment((hre) => {
    const runDeployments = hre.deployments.run.bind(hre.deployments);
    const runFixture = hre.deployments.fixture.bind(hre.deployments);
    hre.deployments.run = async (tags, options) => {
        const selected = Array.isArray(tags) ? tags.join(",") : tags;
        const network = await resolveZeroDelayDeploymentNetwork(hre);
        assertZeroDelayDeploymentSelection(network, {
            tags: selected,
            reset: options?.deletePreviousDeployments,
        });
        await preflightZeroDelayDeployment(hre);
        if (isZeroDelayReleaseNetwork(network)) {
            if (options?.resetMemory === true) {
                throw new Error("Zero delay release: deployment memory reset is not permitted");
            }
            return runDeployments(selected.split(","), { ...options, resetMemory: false });
        }
        return runDeployments(tags, options);
    };
    hre.deployments.fixture = async (tags, options) => {
        if (isZeroDelayReleaseNetwork(await resolveZeroDelayDeploymentNetwork(hre))) {
            throw new Error("Zero delay release: deployment fixtures are not permitted");
        }
        return runFixture(tags, options);
    };
});

task(
    "zero:stage-delay",
    "Stage only the four Perimeter Delay candidates; keep existing proxies"
).setAction(async (_, hre) =>
    hre.run("deploy", { tags: ZERO_DELAY_RELEASE_CANDIDATES.join(",") })
);
