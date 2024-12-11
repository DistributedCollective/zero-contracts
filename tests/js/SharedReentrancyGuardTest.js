const { ethers } = require("hardhat");
const { getOrDeployZeroProtocolMutex } = require("../../deployment/helpers/reentrancy/utils");

describe("SharedReentrancyGuard", async () => {
    let nonReentrantValueSetter;
    let anotherNonReentrantValueSetter;
    let reentrantValueSetter;
    let valueSetterProxy;
    let proxiedValueSetter;

    beforeEach(async () => {
        const NonReentrantValueSetter = await ethers.getContractFactory(
            "TestNonReentrantValueSetter"
        );

        const ValueSetter = await ethers.getContractFactory("TestValueSetter");
        const ValueSetterProxy = await ethers.getContractFactory("TestValueSetterProxy");
        nonReentrantValueSetter = await NonReentrantValueSetter.deploy();
        anotherNonReentrantValueSetter = await NonReentrantValueSetter.deploy();
        reentrantValueSetter = await ValueSetter.deploy();
        valueSetterProxy = await ValueSetterProxy.deploy();
        proxiedValueSetter = await ValueSetter.attach(valueSetterProxy.target);

        // The Mutex singleton must be deployed for SharedReentrancyGuard to work
        await getOrDeployZeroProtocolMutex();
    });

    it("sanity check", async () => {
        expect(await nonReentrantValueSetter.value()).to.equal(0);
        expect(await anotherNonReentrantValueSetter.value()).to.equal(0);
        expect(await reentrantValueSetter.value()).to.equal(0);
        expect(await valueSetterProxy.value()).to.equal(0);
        expect(await proxiedValueSetter.value()).to.equal(0);

        await nonReentrantValueSetter.setValueOpening(1);
        await anotherNonReentrantValueSetter.setValueOpening(2);
        await reentrantValueSetter.setValueOpening(3);

        await valueSetterProxy.setImplementation(reentrantValueSetter.target);
        await proxiedValueSetter.setValueOpening(4);

        expect(await nonReentrantValueSetter.value()).to.equal(1);
        expect(await anotherNonReentrantValueSetter.value()).to.equal(2);
        expect(await reentrantValueSetter.value()).to.equal(3);
        expect(await valueSetterProxy.value()).to.equal(4);
        expect(await proxiedValueSetter.value()).to.equal(4);
    });

    it("globallyNonReentrant call from globallyNonReentrant call reverts", async () => {
        await expect(
            nonReentrantValueSetter.setOtherContractValueNonReentrant(
                anotherNonReentrantValueSetter.target,
                1
            )
        ).to.be.revertedWith("ZeroProtocolMutex: mutex locked");
        expect(await anotherNonReentrantValueSetter.value()).to.equal(0);
    });

    it("non-globallyNonReentrant call from globallyNonReentrant call does not revert", async () => {
        await nonReentrantValueSetter.setOtherContractValueNonReentrant(
            reentrantValueSetter.target,
            1
        );
        expect(await reentrantValueSetter.value()).to.equal(1);
    });

    it("globallyNonReentrant works with proxies", async () => {
        await valueSetterProxy.setImplementation(reentrantValueSetter.target);
        expect(await proxiedValueSetter.value()).to.equal(0);

        await nonReentrantValueSetter.setOtherContractValueNonReentrant(
            valueSetterProxy.target,
            1
        );
        expect(await proxiedValueSetter.value()).to.equal(1);

        await valueSetterProxy.setImplementation(anotherNonReentrantValueSetter.target);
        await expect(
            nonReentrantValueSetter.setOtherContractValueNonReentrant(valueSetterProxy.target, 2)
        ).to.be.revertedWith("ZeroProtocolMutex: mutex locked");
        expect(await proxiedValueSetter.value()).to.equal(1);

        await proxiedValueSetter.setValueOpening(3);
        expect(await proxiedValueSetter.value()).to.equal(3);
    });

    it("works with proxies without breaking the memory layout", async () => {
        await valueSetterProxy.setImplementation(reentrantValueSetter.target);
        expect(await proxiedValueSetter.value()).to.equal(0);

        await proxiedValueSetter.setValueOpening(1);
        expect(await proxiedValueSetter.value()).to.equal(1);

        await valueSetterProxy.setImplementation(anotherNonReentrantValueSetter.target);
        await proxiedValueSetter.setValueOpening(2);
        expect(await proxiedValueSetter.value()).to.equal(2);
    });
});
