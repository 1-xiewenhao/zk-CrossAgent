require("dotenv").config();

const { ethers, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");
const circomlibjs = require("circomlibjs");

// ========================================================
// 1. 归一化 / Poseidon
// ========================================================
function normalizeBatchRoot(value) {
    if (!value) return null;

    if (typeof value === "string" && value.startsWith("0x")) {
        return value.toLowerCase();
    }

    try {
        return ethers.utils.hexZeroPad(
            ethers.BigNumber.from(value).toHexString(),
            32
        ).toLowerCase();
    } catch (_) {
        return null;
    }
}

const SNARK_FIELD_SIZE = ethers.BigNumber.from(
    "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

let poseidon;

function fieldFromHex32(v) {
    return ethers.BigNumber.from(v).mod(SNARK_FIELD_SIZE).toString();
}

function fieldFromUint(v) {
    return ethers.BigNumber.from(v).toString();
}

function poseidonField(inputs) {
    const out = poseidon(inputs.map(x => BigInt(x)));
    return poseidon.F.toString(out);
}

function poseidonFieldToHex(fieldStr) {
    return ethers.utils.hexZeroPad(
        ethers.BigNumber.from(fieldStr).toHexString(),
        32
    ).toLowerCase();
}

function computeLeafFieldFromItem(item) {
    return poseidonField([
        fieldFromHex32(item.callId),
        fieldFromHex32(item.rootCapId),
        fieldFromHex32(item.childCapId),
        fieldFromHex32(item.taskId),
        fieldFromHex32(item.reqHash),
        fieldFromHex32(item.respHash),
        fieldFromUint(item.timestamp),
        fieldFromUint(item.isDummy ? 1 : 0)
    ]);
}

function computeBatchRootFromManifestItems(items) {
    const leafFields = items.map(item => computeLeafFieldFromItem(item));
    return poseidonFieldToHex(poseidonField(leafFields));
}

// ========================================================
// 2. manifest 查找
// ========================================================
async function findManifestByBatchRoot(manifestDir, targetBatchRoot) {
    const files = fs.readdirSync(manifestDir).filter(f => f.endsWith(".json"));
    const normalizedTarget = normalizeBatchRoot(targetBatchRoot);

    for (const file of files) {
        const fullPath = path.join(manifestDir, file);
        const raw = fs.readFileSync(fullPath, "utf-8");
        const manifest = JSON.parse(raw);

        const normalizedManifestRoot = normalizeBatchRoot(manifest.batchRoot);
        if (normalizedManifestRoot && normalizedTarget && normalizedManifestRoot === normalizedTarget) {
            return { manifest, fullPath };
        }
    }

    return null;
}

function verifyManifestBatchRoot(manifest, targetBatchRoot) {
    const recomputedRoot = computeBatchRootFromManifestItems(manifest.items);

    const normalizedManifestRoot = normalizeBatchRoot(manifest.batchRoot);
    const normalizedTargetRoot = normalizeBatchRoot(targetBatchRoot);
    const normalizedRecomputedRoot = normalizeBatchRoot(recomputedRoot);

    if (!normalizedManifestRoot || !normalizedTargetRoot || !normalizedRecomputedRoot) {
        throw new Error("Failed to normalize batch roots");
    }

    if (normalizedManifestRoot !== normalizedTargetRoot) {
        throw new Error(
            `Manifest stored root mismatch: manifest=${normalizedManifestRoot}, event=${normalizedTargetRoot}`
        );
    }

    if (normalizedRecomputedRoot !== normalizedTargetRoot) {
        throw new Error(
            `Manifest recomputed root mismatch: recomputed=${normalizedRecomputedRoot}, event=${normalizedTargetRoot}`
        );
    }

    return true;
}

// ========================================================
// 3. 全局结算队列
// ========================================================
let isSettling = false;
const pendingSettlementJobs = [];

// ========================================================
// 4. 串行处理队列
// ========================================================
async function processSettlementQueue(escrowContract) {
    if (isSettling) return;
    isSettling = true;

    try {
        while (pendingSettlementJobs.length > 0) {
            const job = pendingSettlementJobs.shift();
            const { manifest, fullPath } = job;

            console.log("\n📂 [结算队列] 开始处理一个新批次");
            console.log(`   - manifest: ${fullPath}`);
            console.log(`   - batchId: ${manifest.batchId}`);
            console.log(`   - 真实交易数: ${manifest.itemCount}`);
            console.log(`   - dummy 数量: ${manifest.dummyCount}`);

            let settledCount = 0;
            let skippedDummyCount = 0;
            let failedCount = 0;

            for (const item of manifest.items) {
                if (item.isDummy) {
                    skippedDummyCount += 1;
                    continue;
                }

                const receiptStruct = {
                    callId: item.callId,
                    rootCapId: item.rootCapId,
                    childCapId: item.childCapId,
                    payer: item.payer,
                    caller: item.caller,
                    orchestrator: item.orchestrator,
                    provider: item.provider,
                    providerAmount: item.providerAmount,
                    orchestratorFee: item.orchestratorFee,
                    timestamp: item.timestamp,
                    reqHash: item.reqHash,
                    respHash: item.respHash,
                    sigP: item.sigP,
                    sigC: item.sigC
                };

                console.log(`\n💸 [主网结算] 正在结算 callId=${item.callId}`);
                console.log(`   - provider: ${item.provider}`);
                console.log(`   - orchestrator: ${item.orchestrator}`);
                console.log(`   - providerAmount: ${item.providerAmount}`);
                console.log(`   - orchestratorFee: ${item.orchestratorFee}`);

                try {
                    const tx = await escrowContract.settleReceipt(receiptStruct, {
                        gasLimit: 700000
                    });

                    console.log(`   - 已提交 Sepolia 交易: ${tx.hash}`);
                    await tx.wait();

                    settledCount += 1;
                    console.log("   ✅ 该笔 receipt 分账结算成功");
                } catch (err) {
                    failedCount += 1;
                    console.log(`   ❌ 该笔 receipt 结算失败: ${err.message}`);
                }
            }

            console.log("\n🏁 [批次结算完成]");
            console.log(`   - 成功结算: ${settledCount}`);
            console.log(`   - 跳过 dummy: ${skippedDummyCount}`);
            console.log(`   - 失败笔数: ${failedCount}`);
        }
    } finally {
        isSettling = false;
    }
}

// ========================================================
// 5. 主程序
// ========================================================
async function main() {
    poseidon = await circomlibjs.buildPoseidon();

    console.log("============================================");
    console.log("🌉 [zk-CrossAgent] route-B 分账跨链中继器启动中...");
    console.log("============================================\n");

    const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || "https://rpc-amoy.polygon.technology";
    const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

    const CAP_MANAGER_ADDRESS = process.env.CAP_MANAGER_ADDRESS || "";
    const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || "";
    const MANIFEST_DIR = process.env.MANIFEST_DIR || path.join(__dirname, "../manifests");

    const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY || process.env.GATEWAY_PRIVATE_KEY || "";
    const ENDPOINT_PRIVATE_KEY = process.env.ENDPOINT_PRIVATE_KEY || process.env.GATEWAY_PRIVATE_KEY || "";

    if (!CAP_MANAGER_ADDRESS) {
        throw new Error("Missing CAP_MANAGER_ADDRESS in .env");
    }
    if (!ESCROW_ADDRESS) {
        throw new Error("Missing ESCROW_ADDRESS in .env");
    }
    if (!RELAYER_PRIVATE_KEY) {
        throw new Error("Missing RELAYER_PRIVATE_KEY (or GATEWAY_PRIVATE_KEY) in .env");
    }
    if (!ENDPOINT_PRIVATE_KEY) {
        throw new Error("Missing ENDPOINT_PRIVATE_KEY (or GATEWAY_PRIVATE_KEY) in .env");
    }

    const polygonProvider = new ethers.providers.JsonRpcProvider(POLYGON_RPC_URL);
    const sepoliaProvider = new ethers.providers.JsonRpcProvider(SEPOLIA_RPC_URL);

    const polygonWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, polygonProvider);
    const endpointWallet = new ethers.Wallet(ENDPOINT_PRIVATE_KEY, sepoliaProvider);

    const capManagerArtifact = await artifacts.readArtifact("CapabilityManager");
    const capabilityManager = new ethers.Contract(
        CAP_MANAGER_ADDRESS,
        capManagerArtifact.abi,
        polygonWallet
    );

    const escrowArtifact = await artifacts.readArtifact("EscrowReceipt");
    const escrowContract = new ethers.Contract(
        ESCROW_ADDRESS,
        escrowArtifact.abi,
        endpointWallet
    );

    console.log(`📡 Polygon Relayer 地址: ${polygonWallet.address}`);
    console.log(`🏛️ Sepolia Endpoint 地址: ${endpointWallet.address}`);
    console.log(`🏦 Escrow 合约地址: ${ESCROW_ADDRESS}`);
    console.log(`🧭 CapabilityManager 地址: ${CAP_MANAGER_ADDRESS}`);
    console.log(`📂 Manifest 目录: ${MANIFEST_DIR}`);
    console.log(`⏳ 正在等待 Polygon 的 BatchCapabilityVerifiedZKP 事件...\n`);

    capabilityManager.on("BatchCapabilityVerifiedZKP", async (batchRoot, event) => {
        console.log("\n⚡ [跨链引擎] 捕捉到 Polygon 批量验证成功事件");
        console.log(`   - batchRoot: ${batchRoot}`);
        console.log(`   - txHash: ${event.transactionHash}`);

        try {
            const result = await findManifestByBatchRoot(MANIFEST_DIR, batchRoot);

            if (!result) {
                console.log("❌ 未找到对应 manifest，无法继续主网结算。");
                return;
            }

            const { manifest, fullPath } = result;

            verifyManifestBatchRoot(manifest, batchRoot);

            console.log(`📂 已匹配 manifest: ${fullPath}`);
            console.log(`   - batchId: ${manifest.batchId}`);
            console.log(`   - 真实交易数: ${manifest.itemCount}`);
            console.log(`   - dummy 数量: ${manifest.dummyCount}`);

            pendingSettlementJobs.push({ manifest, fullPath });
            console.log(`📥 已加入结算队列，当前待处理批次数: ${pendingSettlementJobs.length}`);

            await processSettlementQueue(escrowContract);
        } catch (err) {
            console.error("❌ Relayer 处理批次失败:", err.message);
        }
    });

    await new Promise(() => {});
}

main().catch((err) => {
    console.error("❌ Relayer 启动失败:", err.message);
});