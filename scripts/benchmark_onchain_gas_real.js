require("dotenv").config();

const { ethers, artifacts } = require("hardhat");
const snarkjs = require("snarkjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ========================================================
// 0. 配置
// ========================================================
const SEPOLIA_RPC_URL =
    process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const POLYGON_RPC_URL =
    process.env.POLYGON_RPC_URL || "https://rpc-amoy.polygon.technology";

const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || "";
const CAP_MANAGER_ADDRESS = process.env.CAP_MANAGER_ADDRESS || "";

const PAYER_PRIVATE_KEY =
    process.env.PAYER_PRIVATE_KEY || process.env.TRUSTED_ISSUER_PRIVATE_KEY || "";
const ENDPOINT_PRIVATE_KEY = process.env.ENDPOINT_PRIVATE_KEY || "";
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY || "";
const PROVIDER_PRIVATE_KEY = process.env.GATEWAY_PRIVATE_KEY || "";

const PROVIDER_SERVICE_COST = Number(process.env.PROVIDER_SERVICE_COST || 8);
const ORCHESTRATOR_FEE = Number(process.env.ORCHESTRATOR_FEE || 2);
const DEPOSIT_AMOUNT_ETH = process.env.DEPOSIT_AMOUNT_ETH || "0.1";

const FIXED_PROOF_SIZE = Number(process.env.BATCH_SIZE || 10);

// batch circuit
const CIRCUITS_DIR = path.join(__dirname, "../circuits");
const WASM_PATH = path.join(CIRCUITS_DIR, "batch_capability_js/batch_capability.wasm");
const ZKEY_PATH = path.join(CIRCUITS_DIR, "batch_final.zkey");

// baseline（论文对比项）
const BASELINE_SINGLE_GROTH16_GAS = 275000;

// ========================================================
// 1. 工具函数
// ========================================================
function ensure(cond, msg) {
    if (!cond) throw new Error(msg);
}

function ensureFileExists(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing file: ${filePath}`);
    }
}

function toNum(x) {
    return ethers.BigNumber.from(x).toNumber();
}

function randField() {
    return BigInt("0x" + crypto.randomBytes(31).toString("hex")).toString();
}

function buildProviderMsgHash(receiptLike) {
    return ethers.utils.solidityKeccak256(
        [
            "bytes32",
            "bytes32",
            "bytes32",
            "address",
            "address",
            "address",
            "address",
            "uint256",
            "uint256",
            "uint256",
            "bytes32",
            "bytes32"
        ],
        [
            receiptLike.callId,
            receiptLike.rootCapId,
            receiptLike.childCapId,
            receiptLike.payer,
            receiptLike.caller,
            receiptLike.orchestrator,
            receiptLike.provider,
            receiptLike.providerAmount,
            receiptLike.orchestratorFee,
            receiptLike.timestamp,
            receiptLike.reqHash,
            receiptLike.respHash
        ]
    );
}

function buildCallerMsgHash(providerMsgHash, sigP) {
    return ethers.utils.solidityKeccak256(
        ["bytes32", "bytes"],
        [providerMsgHash, sigP]
    );
}

function makeRealItem(index, providerAddress) {
    const rootIssuer = (1000n + BigInt(index)).toString();
    const providerField = ethers.BigNumber.from(providerAddress).toString();
    const rootCapId = randField();

    return {
        rootIssuer,
        rootPerms: "8",
        rootBudget: "100",
        rootExpiry: "999999999",
        rootScopeHash: "777",
        rootCapId,

        childIssuer: rootIssuer,
        childHolder: providerField,
        childPerms: "1",
        childBudget: "8",
        childExpiry: "999999990",
        childScopeHash: "777",
        childParentId: rootCapId,
        childCapId: randField(),

        callId: randField(),
        taskId: randField(),
        reqHash: randField(),
        respHash: randField(),
        timestamp: String(1700000000 + index),
        expectedProvider: providerField,
        isDummy: "0"
    };
}

function buildControlledInput(realCount, fixedSize, providerAddress) {
    const items = [];
    for (let i = 0; i < realCount; i++) {
        items.push(makeRealItem(i + 1, providerAddress));
    }

    if (items.length !== fixedSize) {
        throw new Error(`Experiment-2 expects a full batch: realCount=${realCount}, fixedSize=${fixedSize}`);
    }

    return {
        rootIssuer: items.map((x) => x.rootIssuer),
        rootPerms: items.map((x) => x.rootPerms),
        rootBudget: items.map((x) => x.rootBudget),
        rootExpiry: items.map((x) => x.rootExpiry),
        rootScopeHash: items.map((x) => x.rootScopeHash),
        rootCapId: items.map((x) => x.rootCapId),

        childIssuer: items.map((x) => x.childIssuer),
        childHolder: items.map((x) => x.childHolder),
        childPerms: items.map((x) => x.childPerms),
        childBudget: items.map((x) => x.childBudget),
        childExpiry: items.map((x) => x.childExpiry),
        childScopeHash: items.map((x) => x.childScopeHash),
        childParentId: items.map((x) => x.childParentId),
        childCapId: items.map((x) => x.childCapId),

        callId: items.map((x) => x.callId),
        taskId: items.map((x) => x.taskId),
        reqHash: items.map((x) => x.reqHash),
        respHash: items.map((x) => x.respHash),
        timestamp: items.map((x) => x.timestamp),
        expectedProvider: items.map((x) => x.expectedProvider),
        isDummy: items.map((x) => x.isDummy)
    };
}

// 给 Polygon Amoy 强制设置足够高的 EIP-1559 费用
async function getPolygonGasOverrides(provider) {
    const feeData = await provider.getFeeData();

    const minTip = ethers.utils.parseUnits("30", "gwei");
    const fallbackMaxFee = ethers.utils.parseUnits("60", "gwei");

    const tip =
        feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(minTip)
            ? feeData.maxPriorityFeePerGas
            : minTip;

    let maxFee;
    if (feeData.maxFeePerGas) {
        maxFee = feeData.maxFeePerGas.gt(tip.mul(2))
            ? feeData.maxFeePerGas
            : tip.mul(2);
    } else {
        maxFee = fallbackMaxFee;
    }

    if (maxFee.lt(tip)) {
        maxFee = tip.mul(2);
    }

    return {
        maxPriorityFeePerGas: tip,
        maxFeePerGas: maxFee
    };
}

async function main() {
    console.log("=========================================================");
    console.log("⛽ [Benchmark] zk-CrossAgent 真实链上 Gas 测试");
    console.log("=========================================================\n");

    ensure(ESCROW_ADDRESS, "Missing ESCROW_ADDRESS in .env");
    ensure(CAP_MANAGER_ADDRESS, "Missing CAP_MANAGER_ADDRESS in .env");
    ensure(PAYER_PRIVATE_KEY, "Missing PAYER_PRIVATE_KEY or TRUSTED_ISSUER_PRIVATE_KEY in .env");
    ensure(ENDPOINT_PRIVATE_KEY, "Missing ENDPOINT_PRIVATE_KEY in .env");
    ensure(BUYER_PRIVATE_KEY, "Missing BUYER_PRIVATE_KEY in .env");
    ensure(PROVIDER_PRIVATE_KEY, "Missing GATEWAY_PRIVATE_KEY in .env");

    ensureFileExists(WASM_PATH);
    ensureFileExists(ZKEY_PATH);

    const sepolia = new ethers.providers.JsonRpcProvider(SEPOLIA_RPC_URL);
    const polygon = new ethers.providers.JsonRpcProvider(POLYGON_RPC_URL);

    const payerWallet = new ethers.Wallet(PAYER_PRIVATE_KEY, sepolia);
    const endpointWallet = new ethers.Wallet(ENDPOINT_PRIVATE_KEY, sepolia);
    const buyerWallet = new ethers.Wallet(BUYER_PRIVATE_KEY, sepolia);

    const providerWalletSepolia = new ethers.Wallet(PROVIDER_PRIVATE_KEY, sepolia);
    const providerWalletPolygon = new ethers.Wallet(PROVIDER_PRIVATE_KEY, polygon);

    const escrowArtifact = await artifacts.readArtifact("EscrowReceipt");
    const capManagerArtifact = await artifacts.readArtifact("CapabilityManager");

    const escrow = new ethers.Contract(
        ESCROW_ADDRESS,
        escrowArtifact.abi,
        sepolia
    );

    const capManager = new ethers.Contract(
        CAP_MANAGER_ADDRESS,
        capManagerArtifact.abi,
        polygon
    );

    const trustedEndpointOnChain = await escrow.trustedCrossChainEndpoint();
    console.log(`Escrow address              : ${ESCROW_ADDRESS}`);
    console.log(`CapabilityManager address   : ${CAP_MANAGER_ADDRESS}`);
    console.log(`Payer                       : ${payerWallet.address}`);
    console.log(`Buyer                       : ${buyerWallet.address}`);
    console.log(`Provider                    : ${providerWalletSepolia.address}`);
    console.log(`Endpoint (wallet)           : ${endpointWallet.address}`);
    console.log(`Trusted endpoint (on-chain) : ${trustedEndpointOnChain}\n`);

    if (trustedEndpointOnChain.toLowerCase() !== endpointWallet.address.toLowerCase()) {
        throw new Error(
            `Trusted endpoint mismatch: on-chain=${trustedEndpointOnChain}, wallet=${endpointWallet.address}`
        );
    }

    // ------------------------------------------------------
    // 1) 生成一批 10 笔真实交易的 batch proof/publicSignals
    // ------------------------------------------------------
    console.log("🧩 正在本地生成 batch proof / publicSignals ...");

    const controlledInput = buildControlledInput(
        FIXED_PROOF_SIZE,
        FIXED_PROOF_SIZE,
        providerWalletPolygon.address
    );

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        controlledInput,
        WASM_PATH,
        ZKEY_PATH
    );

    const a = [proof.pi_a[0], proof.pi_a[1]];
    const b = [
        [proof.pi_b[0][1], proof.pi_b[0][0]],
        [proof.pi_b[1][1], proof.pi_b[1][0]]
    ];
    const c = [proof.pi_c[0], proof.pi_c[1]];
    const input = publicSignals;

    // ------------------------------------------------------
    // 2) registerBatchZKP（真实 Polygon Amoy 合约）
    // ------------------------------------------------------
    console.log("📤 正在向 Polygon Amoy 提交 registerBatchZKP ...");

    const polygonGasOverrides = await getPolygonGasOverrides(polygon);
    console.log(
        `Polygon gas overrides      : tip=${ethers.utils.formatUnits(
            polygonGasOverrides.maxPriorityFeePerGas,
            "gwei"
        )} gwei, maxFee=${ethers.utils.formatUnits(
            polygonGasOverrides.maxFeePerGas,
            "gwei"
        )} gwei`
    );

    const capManagerWithSigner = capManager.connect(providerWalletPolygon);
    const estimateBatch = await capManagerWithSigner.estimateGas.registerBatchZKP(
        a,
        b,
        c,
        input,
        polygonGasOverrides
    );
    const txBatch = await capManagerWithSigner.registerBatchZKP(
        a,
        b,
        c,
        input,
        {
            ...polygonGasOverrides,
            gasLimit: estimateBatch.mul(12).div(10)
        }
    );
    const rcBatch = await txBatch.wait();

    console.log(`registerBatchZKP txHash     : ${txBatch.hash}`);
    console.log(`registerBatchZKP estimate   : ${estimateBatch.toString()}`);
    console.log(`registerBatchZKP gasUsed    : ${rcBatch.gasUsed.toString()}\n`);

    // ------------------------------------------------------
    // 3) depositFor（真实 Sepolia 合约）
    // ------------------------------------------------------
    console.log("💰 正在向 Sepolia Escrow 充值 depositFor ...");

    const escrowWithPayer = escrow.connect(payerWallet);
    const depositValue = ethers.utils.parseEther(DEPOSIT_AMOUNT_ETH);

    const estimateDeposit = await escrowWithPayer.estimateGas.depositFor(
        payerWallet.address,
        { value: depositValue }
    );
    const txDeposit = await escrowWithPayer.depositFor(
        payerWallet.address,
        { value: depositValue }
    );
    const rcDeposit = await txDeposit.wait();

    console.log(`depositFor txHash           : ${txDeposit.hash}`);
    console.log(`depositFor estimate         : ${estimateDeposit.toString()}`);
    console.log(`depositFor gasUsed          : ${rcDeposit.gasUsed.toString()}\n`);

    // ------------------------------------------------------
    // 4) settleReceipt（真实 Sepolia 合约）
    // ------------------------------------------------------
    console.log("🧾 正在向 Sepolia Escrow 提交 settleReceipt ...");

    const receiptLike = {
        callId: ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["string", "uint256", "uint256"],
                ["benchmark-settle", Date.now(), Math.floor(Math.random() * 1e9)]
            )
        ),
        rootCapId: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("root-cap-benchmark")),
        childCapId: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("child-cap-benchmark")),
        payer: payerWallet.address,
        caller: buyerWallet.address,
        orchestrator: buyerWallet.address,
        provider: providerWalletSepolia.address,
        providerAmount: PROVIDER_SERVICE_COST,
        orchestratorFee: ORCHESTRATOR_FEE,
        timestamp: Math.floor(Date.now() / 1000),
        reqHash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("benchmark request")),
        respHash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("benchmark response"))
    };

    const providerMsgHash = buildProviderMsgHash(receiptLike);
    const sigP = await providerWalletSepolia.signMessage(ethers.utils.arrayify(providerMsgHash));

    const callerMsgHash = buildCallerMsgHash(providerMsgHash, sigP);
    const sigC = await buyerWallet.signMessage(ethers.utils.arrayify(callerMsgHash));

    const receiptStruct = {
        ...receiptLike,
        sigP,
        sigC
    };

    const escrowWithEndpoint = escrow.connect(endpointWallet);
    const estimateSettle = await escrowWithEndpoint.estimateGas.settleReceipt(receiptStruct);
    const txSettle = await escrowWithEndpoint.settleReceipt(receiptStruct);
    const rcSettle = await txSettle.wait();

    console.log(`settleReceipt txHash        : ${txSettle.hash}`);
    console.log(`settleReceipt estimate      : ${estimateSettle.toString()}`);
    console.log(`settleReceipt gasUsed       : ${rcSettle.gasUsed.toString()}\n`);

    // ------------------------------------------------------
    // 5) 输出结果
    // ------------------------------------------------------
    const result = {
        generatedAt: new Date().toISOString(),
        contracts: {
            escrowAddress: ESCROW_ADDRESS,
            capManagerAddress: CAP_MANAGER_ADDRESS,
            trustedEndpointOnChain
        },
        accounts: {
            payer: payerWallet.address,
            buyer: buyerWallet.address,
            provider: providerWalletSepolia.address,
            endpoint: endpointWallet.address
        },
        config: {
            depositAmountEth: DEPOSIT_AMOUNT_ETH,
            providerServiceCost: PROVIDER_SERVICE_COST,
            orchestratorFee: ORCHESTRATOR_FEE,
            fixedProofSize: FIXED_PROOF_SIZE,
            polygonGasOverrides: {
                maxPriorityFeePerGasGwei: ethers.utils.formatUnits(
                    polygonGasOverrides.maxPriorityFeePerGas,
                    "gwei"
                ),
                maxFeePerGasGwei: ethers.utils.formatUnits(
                    polygonGasOverrides.maxFeePerGas,
                    "gwei"
                )
            },
            baselineSingleGroth16VerifyGas: BASELINE_SINGLE_GROTH16_GAS
        },
        gas: {
            registerBatchZKP: {
                txHash: txBatch.hash,
                estimateGas: toNum(estimateBatch),
                gasUsed: toNum(rcBatch.gasUsed)
            },
            depositFor: {
                txHash: txDeposit.hash,
                estimateGas: toNum(estimateDeposit),
                gasUsed: toNum(rcDeposit.gasUsed)
            },
            settleReceipt: {
                txHash: txSettle.hash,
                estimateGas: toNum(estimateSettle),
                gasUsed: toNum(rcSettle.gasUsed)
            },
            baselineSingleGroth16Verify: {
                gasUsedRepresentative: BASELINE_SINGLE_GROTH16_GAS
            }
        }
    };

    const outDir = path.join(__dirname, "../benchmark_results");
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const outPath = path.join(outDir, "benchmark_onchain_gas_real_results.json");
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

    console.log("=========================================================");
    console.log("📊 实验二核心 Gas 结果");
    console.log("=========================================================");
    console.log(`depositFor gasUsed            : ${result.gas.depositFor.gasUsed}`);
    console.log(`registerBatchZKP gasUsed      : ${result.gas.registerBatchZKP.gasUsed}`);
    console.log(`settleReceipt gasUsed         : ${result.gas.settleReceipt.gasUsed}`);
    console.log(`single Groth16 baseline (ref) : ${result.gas.baselineSingleGroth16Verify.gasUsedRepresentative}`);
    console.log(`\n✅ 结果已写入: ${outPath}`);
}

main().catch((err) => {
    console.error("❌ benchmark_onchain_gas_real 运行失败:", err);
    process.exit(1);
});