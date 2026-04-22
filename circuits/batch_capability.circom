pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

/*
 * 一笔 leaf：
 * 1) 验证 root -> child 的单调衰减
 * 2) 绑定这笔交易的唯一标识
 * 3) 输出 leaf commitment
 */
template BatchAuthLeaf() {
    // ---------- root capability ----------
    signal input rootIssuer;
    signal input rootPerms;
    signal input rootBudget;
    signal input rootExpiry;
    signal input rootScopeHash;
    signal input rootCapId;

    // ---------- child capability ----------
    signal input childIssuer;
    signal input childHolder;
    signal input childPerms;
    signal input childBudget;
    signal input childExpiry;
    signal input childScopeHash;
    signal input childParentId;
    signal input childCapId;

    // ---------- receipt/task uniqueness ----------
    signal input callId;
    signal input taskId;
    signal input reqHash;
    signal input respHash;
    signal input timestamp;

    // ---------- fixed expected holder ----------
    signal input expectedProvider;

    // ---------- dummy flag ----------
    signal input isDummy; // 0 or 1

    signal output leaf;

    // isDummy must be boolean
    isDummy * (isDummy - 1) === 0;

    // --------- 真实交易约束在 (1 - isDummy) 分支生效 ---------
    signal real;
    real <== 1 - isDummy;

    // 1) childIssuer == rootIssuer
    (childIssuer - rootIssuer) * real === 0;

    // 2) childParentId == rootCapId
    (childParentId - rootCapId) * real === 0;

    // 3) childHolder == expectedProvider
    (childHolder - expectedProvider) * real === 0;

    // 4) childScopeHash == rootScopeHash
    (childScopeHash - rootScopeHash) * real === 0;

    // 5) childCapId != 0 for real items (简化版先略，可后加非零约束)
    // 6) budget monotonic attenuation: childBudget <= rootBudget
    component budgetCmp = LessEqThan(64);
    budgetCmp.in[0] <== childBudget;
    budgetCmp.in[1] <== rootBudget;
    (budgetCmp.out - 1) * real === 0;

    // 7) expiry monotonic attenuation: childExpiry <= rootExpiry
    component expiryCmp = LessEqThan(64);
    expiryCmp.in[0] <== childExpiry;
    expiryCmp.in[1] <== rootExpiry;
    (expiryCmp.out - 1) * real === 0;

    // 8) perms attenuation
    // 简化：先要求 childPerms <= rootPerms
    // 若你 perms 是 bitmask，下一版应改为逐位约束 child_bit <= root_bit
    component permsCmp = LessEqThan(64);
    permsCmp.in[0] <== childPerms;
    permsCmp.in[1] <== rootPerms;
    (permsCmp.out - 1) * real === 0;

    // --------- 叶子绑定唯一交易内容 ---------
    component h = Poseidon(8);
    h.inputs[0] <== callId;
    h.inputs[1] <== rootCapId;
    h.inputs[2] <== childCapId;
    h.inputs[3] <== taskId;
    h.inputs[4] <== reqHash;
    h.inputs[5] <== respHash;
    h.inputs[6] <== timestamp;
    h.inputs[7] <== isDummy;

    leaf <== h.out;
}

template BatchCapabilityAuthBounded(N) {
    // root
    signal input rootIssuer[N];
    signal input rootPerms[N];
    signal input rootBudget[N];
    signal input rootExpiry[N];
    signal input rootScopeHash[N];
    signal input rootCapId[N];

    // child
    signal input childIssuer[N];
    signal input childHolder[N];
    signal input childPerms[N];
    signal input childBudget[N];
    signal input childExpiry[N];
    signal input childScopeHash[N];
    signal input childParentId[N];
    signal input childCapId[N];

    // receipt/task uniqueness
    signal input callId[N];
    signal input taskId[N];
    signal input reqHash[N];
    signal input respHash[N];
    signal input timestamp[N];

    // common expected provider
    signal input expectedProvider[N];

    // dummy
    signal input isDummy[N];

    signal output batchRoot;

    component leaves[N];
    component rootHasher = Poseidon(N);

    for (var i = 0; i < N; i++) {
        leaves[i] = BatchAuthLeaf();

        leaves[i].rootIssuer <== rootIssuer[i];
        leaves[i].rootPerms <== rootPerms[i];
        leaves[i].rootBudget <== rootBudget[i];
        leaves[i].rootExpiry <== rootExpiry[i];
        leaves[i].rootScopeHash <== rootScopeHash[i];
        leaves[i].rootCapId <== rootCapId[i];

        leaves[i].childIssuer <== childIssuer[i];
        leaves[i].childHolder <== childHolder[i];
        leaves[i].childPerms <== childPerms[i];
        leaves[i].childBudget <== childBudget[i];
        leaves[i].childExpiry <== childExpiry[i];
        leaves[i].childScopeHash <== childScopeHash[i];
        leaves[i].childParentId <== childParentId[i];
        leaves[i].childCapId <== childCapId[i];

        leaves[i].callId <== callId[i];
        leaves[i].taskId <== taskId[i];
        leaves[i].reqHash <== reqHash[i];
        leaves[i].respHash <== respHash[i];
        leaves[i].timestamp <== timestamp[i];
        leaves[i].expectedProvider <== expectedProvider[i];
        leaves[i].isDummy <== isDummy[i];

        rootHasher.inputs[i] <== leaves[i].leaf;
    }

    batchRoot <== rootHasher.out;
}

component main = BatchCapabilityAuthBounded(10);